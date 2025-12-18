import dotenv from 'dotenv'
import http from 'http'
import https from 'https'
import WebSocket, { WebSocketServer } from 'ws'
import { supabase } from './supabaseClient.js'
import { parse as parseUrl } from 'url'
import axios from 'axios'
import fs from 'fs'

dotenv.config()

const {
  OPENAI_API_KEY,
  PORT = 8080,
  PROMPT_REFRESH_SECRET,
  ROUTER_ENDPOINT,
  ITEM_SEARCH_ENDPOINT,
  PICKUP_ENDPOINT,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  ELEVENLABS_MODEL_ID,
} = process.env

// ---------------------------------------------------------------------------
// 0. ENV GUARDS
// ---------------------------------------------------------------------------

if (!OPENAI_API_KEY) {
  console.error('[Fatal] Missing OPENAI_API_KEY')
  process.exit(1)
}
if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
  console.error('[Fatal] ELEVENLABS credentials missing. TTS will fail.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. LOAD STATIC GREETING AUDIO (RAW µ-law 8kHz, NOT WAV/MP3/M4A)
// ---------------------------------------------------------------------------

let GREETING_AUDIO = null
try {
  // This must be raw G.711 µ-law 8kHz audio bytes (no container header).
  // Filename extension can be .ulaw, but it is still raw bytes.
  GREETING_AUDIO = fs.readFileSync('./greeting.ulaw')
  console.log('[Greeting] Loaded greeting.ulaw, bytes=', GREETING_AUDIO.length)
} catch (e) {
  console.warn('[Greeting] No greeting.ulaw found (or unreadable). Static greeting will be skipped.')
}

// ---------------------------------------------------------------------------
// 2. PROMPT CACHE
// ---------------------------------------------------------------------------

const PROMPTS = { router: '', items: '', pickup: '' }

async function reloadPromptsFromDB() {
  try {
    const { data, error } = await supabase
      .from('cl_phone_agents')
      .select('slug, system_prompt')
      .in('slug', ['router-dev', 'item-dev', 'locations-dev'])

    if (error) {
      console.error('[Prompts] Error loading from DB:', error)
      return
    }

    PROMPTS.router = ''
    PROMPTS.items = ''
    PROMPTS.pickup = ''

    for (const row of data || []) {
      if (row.slug === 'router-dev') PROMPTS.router = row.system_prompt || ''
      if (row.slug === 'item-dev') PROMPTS.items = row.system_prompt || ''
      if (row.slug === 'locations-dev') PROMPTS.pickup = row.system_prompt || ''
    }

    console.log(
      '[Prompts] Reloaded:',
      'router=', PROMPTS.router ? 'OK' : 'MISSING',
      'items=', PROMPTS.items ? 'OK' : 'MISSING',
      'pickup=', PROMPTS.pickup ? 'OK' : 'MISSING'
    )
  } catch (e) {
    console.error('[Prompts] Unexpected error reloading:', e)
  }
}

await reloadPromptsFromDB()

// ---------------------------------------------------------------------------
// 3. HTTP SERVER (/refresh-prompts)
// ---------------------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/refresh-prompts') {
    const authHeader = req.headers['authorization'] || ''
    if (!PROMPT_REFRESH_SECRET || authHeader !== `Bearer ${PROMPT_REFRESH_SECRET}`) {
      res.writeHead(401, { 'Content-Type': 'text/plain' })
      return res.end('unauthorized')
    }
    await reloadPromptsFromDB()
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end('ok')
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found')
})

const wss = new WebSocketServer({ server: httpServer })

httpServer.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`)
})

// ---------------------------------------------------------------------------
// 4. AXIOS INSTANCE (Keep-Alive for faster ElevenLabs + tool calls)
// ---------------------------------------------------------------------------

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 })
const axiosClient = axios.create({
  timeout: 15000,
  httpsAgent,
})

// ---------------------------------------------------------------------------
// 5. WS SERVER (Twilio <-> OpenAI Realtime + ElevenLabs TTS)
// ---------------------------------------------------------------------------

wss.on('connection', (twilioWs, req) => {
  const { pathname } = parseUrl(req.url || '', true)
  if (pathname !== '/twilio-stream') {
    console.log('[WS] Unknown path:', pathname)
    try { twilioWs.close() } catch {}
    return
  }

  console.log('[WS] New Twilio Connection')

  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  )

  // -----------------------------
  // Per-call state
  // -----------------------------

  let currentAgent = 'router'
  let callSid = null
  let streamSid = null

  let openaiReady = false
  let twilioStarted = false

  // Speech / response gating (prevents “answers to questions I never asked”)
  let isAssistantSpeaking = false
  let userAudioSinceLastTurn = false
  let awaitingResponse = false
  let responseOrigin = null // 'user' | 'tool' | null

  // For text we’ll speak via ElevenLabs
  let assistantTranscript = ''
  let assistantText = ''

  // Tool tracking
  const functionCallMap = new Map()

  // -----------------------------
  // Twilio send helpers
  // -----------------------------

  function sendTwilioMediaFrame(b64) {
    if (!streamSid) return
    if (twilioWs.readyState !== WebSocket.OPEN) return
    twilioWs.send(
      JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: b64 },
      })
    )
  }

  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  // -----------------------------
  // Static greeting playback (raw µ-law 8kHz)
  // -----------------------------

  async function playGreetingFromFile() {
    if (!GREETING_AUDIO) return
    if (!streamSid) return

    console.log('[Greeting] Playing static greeting over Twilio stream')
    isAssistantSpeaking = true

    const FRAME_SIZE = 160 // 20ms @ 8kHz µ-law
    try {
      for (let i = 0; i < GREETING_AUDIO.length; i += FRAME_SIZE) {
        const chunk = GREETING_AUDIO.subarray(i, i + FRAME_SIZE)
        sendTwilioMediaFrame(chunk.toString('base64'))
        await sleep(20)
      }
    } catch (e) {
      console.error('[Greeting] Error while streaming greeting:', e)
    } finally {
      isAssistantSpeaking = false
      console.log('[Greeting] Finished static greeting playback')
    }
  }

  // -----------------------------
  // ElevenLabs TTS (dynamic)
  // -----------------------------

  async function speakWithElevenLabs(text) {
    const cleaned = (text || '').trim()
    if (!cleaned) return
    if (!streamSid) return

    isAssistantSpeaking = true

    try {
      const modelId = ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5'

      const resp = await axiosClient.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=ulaw_8000`,
        {
          text: cleaned,
          model_id: modelId,
          voice_settings: {
            stability: 0.8,
            similarity_boost: 0.0,
            style: 0.3,
            speed: 0.93,
          },
        },
        {
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
          },
          responseType: 'arraybuffer',
        }
      )

      const audioBuffer = Buffer.from(resp.data)
      const FRAME_SIZE = 160

      // Slightly faster than real-time, but still gentle enough not to flood Twilio.
      // If you hear buffering/lag, increase to 10–20ms.
      for (let i = 0; i < audioBuffer.length; i += FRAME_SIZE) {
        const chunk = audioBuffer.subarray(i, i + FRAME_SIZE)
        sendTwilioMediaFrame(chunk.toString('base64'))
        await sleep(5)
      }
    } catch (err) {
      console.error('[ElevenLabs] TTS Error:', err?.response?.data || err?.message || err)
    } finally {
      isAssistantSpeaking = false
    }
  }

  // -----------------------------
  // OpenAI: response.create gating
  // -----------------------------

  function requestAssistantResponse(origin) {
    if (!openaiReady) return
    if (!twilioStarted) return
    if (awaitingResponse) return

    // Critical: only respond if user actually spoke (for user-origin)
    if (origin === 'user' && !userAudioSinceLastTurn) return

    awaitingResponse = true
    responseOrigin = origin
    userAudioSinceLastTurn = false

    try {
      openaiWs.send(JSON.stringify({ type: 'response.create' }))
    } catch (e) {
      awaitingResponse = false
      responseOrigin = null
    }
  }

  // -----------------------------
  // OpenAI WS events
  // -----------------------------

  openaiWs.on('open', () => {
    console.log('[OpenAI] Connected')

    const routerPrompt = PROMPTS.router || 'You are the Chasdei Lev router agent.'

    openaiWs.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          instructions: routerPrompt,
          modalities: ['audio', 'text'],
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          turn_detection: { type: 'server_vad' },
          tools: [
            {
              type: 'function',
              name: 'determine_route',
              description:
                'Classify caller intent for Chasdei Lev phone calls and decide which agent should handle it.',
              parameters: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  ai_classification: { type: 'string' },
                },
                required: ['message', 'ai_classification'],
              },
            },
          ],
        },
      })
    )

    openaiReady = true
  })

  openaiWs.on('message', async (raw) => {
    let event
    try {
      event = JSON.parse(raw.toString())
    } catch {
      return
    }

    switch (event.type) {
      case 'response.created': {
        assistantTranscript = ''
        assistantText = ''
        break
      }

      // We ignore OpenAI audio bytes entirely; we speak with ElevenLabs
      case 'response.audio.delta': {
        break
      }

      case 'response.audio_transcript.delta': {
        if (typeof event.delta === 'string') assistantTranscript += event.delta
        break
      }

      case 'response.output_text.delta': {
        if (typeof event.delta === 'string') assistantText += event.delta
        break
      }

      // These events indicate OpenAI heard speech boundaries (server_vad)
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed': {
        // Trigger a response only if the user actually spoke and we're not speaking
        if (!isAssistantSpeaking) {
          requestAssistantResponse('user')
        }
        break
      }

      case 'response.output_item.added': {
        const item = event.item
        if (item?.type === 'function_call' && item.call_id && item.name) {
          functionCallMap.set(item.call_id, item.name)
        }
        break
      }

      case 'response.function_call_arguments.done': {
        const callId = event.call_id
        const toolName = functionCallMap.get(callId)
        if (!toolName) break

        let args = {}
        try {
          args = JSON.parse(event.arguments || '{}')
        } catch (e) {
          console.error('[Tool] Failed to parse arguments JSON:', e, event.arguments)
        }

        await handleToolCall(toolName, args, callId)
        break
      }

      case 'response.done': {
        awaitingResponse = false

        const textToSpeak = (assistantTranscript || assistantText || '').trim()

        // If OpenAI produced text but we did NOT explicitly request a response,
        // suppress it to prevent “answers to things I never asked.”
        if (!responseOrigin) {
          assistantTranscript = ''
          assistantText = ''
          break
        }

        if (textToSpeak) {
          console.log(`[Assistant][${currentAgent}]`, textToSpeak)
          await speakWithElevenLabs(textToSpeak)
        }

        responseOrigin = null
        assistantTranscript = ''
        assistantText = ''
        break
      }

      case 'error': {
        console.error('[OpenAI error event]', event)
        break
      }

      default:
        break
    }
  })

  openaiWs.on('close', () => {
    console.log('[OpenAI] Socket closed')
    try { twilioWs.close() } catch {}
  })

  openaiWs.on('error', (err) => {
    console.error('[OpenAI] WS Error:', err)
    try { twilioWs.close() } catch {}
  })

  // -----------------------------
  // Twilio WS events
  // -----------------------------

  twilioWs.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.event === 'start') {
      callSid = msg.start?.callSid || null
      streamSid = msg.start?.streamSid || null
      twilioStarted = true
      console.log('[Twilio] Stream Started:', callSid, 'streamSid=', streamSid)

      // Start greeting immediately; OpenAI can initialize in parallel.
      if (GREETING_AUDIO) {
        playGreetingFromFile().catch((e) => console.error('[Greeting] Playback error:', e))
      }
      return
    }

    if (msg.event === 'media') {
      // No-barge-in: drop user audio while assistant is speaking (including greeting).
      if (isAssistantSpeaking) return
      if (!openaiReady) return

      userAudioSinceLastTurn = true

      try {
        openaiWs.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload,
          })
        )
      } catch {}
      return
    }

    if (msg.event === 'stop') {
      console.log('[Twilio] Call ended', callSid)
      try { openaiWs.close() } catch {}
      return
    }
  })

  twilioWs.on('close', () => {
    console.log('[WS] Twilio websocket closed')
    try { openaiWs.close() } catch {}
  })

  twilioWs.on('error', (err) => {
    console.error('[WS] Twilio WS Error:', err)
    try { openaiWs.close() } catch {}
  })

  // -------------------------------------------------------------------------
  // TOOL CALLS
  // -------------------------------------------------------------------------

  async function handleToolCall(toolName, args, callId) {
    try {
      if (toolName === 'determine_route') {
        if (!ROUTER_ENDPOINT) {
          console.error('[Tool] ROUTER_ENDPOINT not configured')
          openaiWs.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({ intent: 'unknown' }),
              },
            })
          )
          requestAssistantResponse('tool')
          return
        }

        const resp = await axiosClient.post(ROUTER_ENDPOINT, {
          ...args,
          call_sid: callSid,
          current_agent: currentAgent,
        })

        const output = resp.data || {}

        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify(output),
            },
          })
        )

        if (output.intent === 'items') {
          await handleHandoff({
            handoff_from: 'router',
            intent: 'items',
            question_type: output.question_type || 'specific',
            question: output.cleaned_question || null,
          })
          return
        }

        if (output.intent === 'pickup') {
          await handleHandoff({
            handoff_from: 'router',
            intent: 'pickup',
            question_type: output.question_type || 'specific',
            question: output.cleaned_question || null,
          })
          return
        }

        // orders/meta/unknown => let router say its fallback line
        requestAssistantResponse('tool')
        return
      }

      if (toolName === 'search_items') {
        if (!ITEM_SEARCH_ENDPOINT) {
          console.error('[Tool] ITEM_SEARCH_ENDPOINT not configured')
          openaiWs.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({ results: [], error: 'ITEM_SEARCH_ENDPOINT not configured' }),
              },
            })
          )
          requestAssistantResponse('tool')
          return
        }

        const resp = await axiosClient.post(ITEM_SEARCH_ENDPOINT, {
          ...args,
          call_sid: callSid,
        })

        const output = resp.data || {}

        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify(output),
            },
          })
        )

        requestAssistantResponse('tool')
        return
      }

      if (toolName === 'search_pickup_locations') {
        if (!PICKUP_ENDPOINT) {
          console.error('[Tool] PICKUP_ENDPOINT not configured')
          openaiWs.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({ results: [], error: 'PICKUP_ENDPOINT not configured' }),
              },
            })
          )
          requestAssistantResponse('tool')
          return
        }

        const resp = await axiosClient.post(PICKUP_ENDPOINT, {
          ...args,
          call_sid: callSid,
        })

        const output = resp.data || {}

        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify(output),
            },
          })
        )

        requestAssistantResponse('tool')
        return
      }

      if (toolName === 'handoff_to_router') {
        const cleanedQuestion = typeof args.question === 'string' ? args.question.trim() : ''

        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify({ ok: true }),
            },
          })
        )

        await handleHandoff({
          handoff_from: currentAgent,
          intent: 'router',
          question_type: 'specific',
          question: cleanedQuestion || null,
        })

        return
      }

      console.warn('[Tool] Unknown toolName:', toolName)
    } catch (err) {
      console.error('[Tool] Error in handleToolCall', toolName, err?.response?.data || err)
      try {
        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify({ error: 'tool_failed' }),
            },
          })
        )
        requestAssistantResponse('tool')
      } catch {}
    }
  }

  // -------------------------------------------------------------------------
  // AGENT SWITCHING
  // -------------------------------------------------------------------------

  async function handleHandoff(h) {
    console.log('[Handoff]', h)
    if (!h || !h.intent) return

    if (h.intent === 'items') {
      currentAgent = 'items'
      const itemsPrompt = PROMPTS.items || 'You are the Chasdei Lev items agent.'

      openaiWs.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            instructions: itemsPrompt,
            tools: [
              {
                type: 'function',
                name: 'search_items',
                description:
                  'Search the Chasdei Lev items database and answer kashrus and package questions based ONLY on the provided data.',
                parameters: {
                  type: 'object',
                  properties: { query: { type: 'string' } },
                  required: ['query'],
                },
              },
              {
                type: 'function',
                name: 'handoff_to_router',
                description:
                  'Return control to the router agent when the caller asks about something other than items.',
                parameters: {
                  type: 'object',
                  properties: { question: { type: 'string' } },
                  required: ['question'],
                },
              },
            ],
          },
        })
      )

      if (h.question && typeof h.question === 'string' && h.question.trim()) {
        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: h.question.trim() }],
            },
          })
        )
        requestAssistantResponse('tool')
      }

      return
    }

    if (h.intent === 'pickup') {
      currentAgent = 'pickup'
      const pickupPrompt = PROMPTS.pickup || 'You are the Chasdei Lev pickup agent.'

      openaiWs.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            instructions: pickupPrompt,
            tools: [
              {
                type: 'function',
                name: 'search_pickup_locations',
                description:
                  'Search the Chasdei Lev distribution locations database and answer pickup time/location questions based ONLY on the provided data.',
                parameters: {
                  type: 'object',
                  properties: { location_query: { type: 'string' } },
                  required: ['location_query'],
                },
              },
              {
                type: 'function',
                name: 'handoff_to_router',
                description:
                  'Return control to the router agent when the caller asks about something other than pickup.',
                parameters: {
                  type: 'object',
                  properties: { question: { type: 'string' } },
                  required: ['question'],
                },
              },
            ],
          },
        })
      )

      if (h.question && typeof h.question === 'string' && h.question.trim()) {
        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: h.question.trim() }],
            },
          })
        )
        requestAssistantResponse('tool')
      }

      return
    }

    if (h.intent === 'router') {
      currentAgent = 'router'
      const routerPrompt = PROMPTS.router || 'You are the Chasdei Lev router agent.'

      openaiWs.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            instructions: routerPrompt,
            tools: [
              {
                type: 'function',
                name: 'determine_route',
                description:
                  'Classify caller intent for Chasdei Lev phone calls and decide which agent should handle it.',
                parameters: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    ai_classification: { type: 'string' },
                  },
                  required: ['message', 'ai_classification'],
                },
              },
            ],
          },
        })
      )

      if (h.question && typeof h.question === 'string' && h.question.trim()) {
        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: h.question.trim() }],
            },
          })
        )
        requestAssistantResponse('tool')
      }

      return
    }
  }
})
