// server.js
import dotenv from 'dotenv'
import http from 'http'
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
// 1. LOAD STATIC GREETING AUDIO (µ-law 8kHz!!)
// ---------------------------------------------------------------------------

let GREETING_AUDIO = null
try {
  // IMPORTANT: This file MUST be 8kHz G.711 µ-law (same as Twilio's media stream).
  // E.g. generated from ElevenLabs with output_format=ulaw_8000.
  GREETING_AUDIO = fs.readFileSync('./greeting.wav')
  console.log('[Greeting] Loaded greeting.ulaw, bytes=', GREETING_AUDIO.length)
} catch (e) {
  console.error('[Greeting] Failed to load greeting.ulaw:', e.message)
  // We won't crash the server, but no static greeting will play.
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
// 3. HTTP SERVER
// ---------------------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/refresh-prompts') {
    const authHeader = req.headers['authorization'] || ''
    if (!PROMPT_REFRESH_SECRET || authHeader !== `Bearer ${PROMPT_REFRESH_SECRET}`) {
      res.writeHead(401)
      return res.end('unauthorized')
    }
    await reloadPromptsFromDB()
    res.writeHead(200)
    return res.end('ok')
  }

  res.writeHead(404)
  res.end('not found')
})

const wss = new WebSocketServer({ server: httpServer })

httpServer.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`)
})

// ---------------------------------------------------------------------------
// 4. WS SERVER (Twilio <-> OpenAI + ElevenLabs)
// ---------------------------------------------------------------------------

wss.on('connection', async (twilioWs, req) => {
  const { pathname } = parseUrl(req.url || '', true)
  if (pathname !== '/twilio-stream') {
    console.log('[WS] Unknown path:', pathname)
    twilioWs.close()
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

  // Session State
  let isAssistantSpeaking = false
  let currentAgent = 'router'
  let callSid = null
  let streamSid = null
  let openaiReady = false

  // We'll play the greeting ourselves from file, so
  // we do NOT want OpenAI to say its own greeting.
  const suppressFirstAssistantUtterance = true
  let firstAssistantDone = false

  // Text accumulation for ElevenLabs
  let assistantTranscript = ''
  let assistantText = ''
  const functionCallMap = new Map()

  // -------------------------------------------------------------------------
  // ElevenLabs TTS for dynamic responses
  // -------------------------------------------------------------------------

  async function speakWithElevenLabs(text) {
    if (!text || !text.trim()) return
    if (!streamSid) {
      console.warn('[TTS] No streamSid yet, skipping TTS')
      return
    }

    try {
      isAssistantSpeaking = true
      console.log(`[ElevenLabs] Synthesizing: "${text.substring(0, 40)}..."`)

      const modelId = ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5'

      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=ulaw_8000`,
        {
          text,
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

      const audioBuffer = Buffer.from(response.data)
      const FRAME_SIZE = 160 // 20 ms at 8kHz µ-law

      for (let i = 0; i < audioBuffer.length; i += FRAME_SIZE) {
        const chunk = audioBuffer.subarray(i, i + FRAME_SIZE)
        const b64 = chunk.toString('base64')

        twilioWs.send(
          JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: b64 },
          })
        )

        // small pacing so we don't flood Twilio
        await new Promise((r) => setTimeout(r, 10))
      }
    } catch (err) {
      console.error('[ElevenLabs] TTS Error:', err?.response?.data || err)
    } finally {
      isAssistantSpeaking = false
    }
  }

  // -------------------------------------------------------------------------
  // Static greeting playback from local file (µ-law 8kHz)
// ---------------------------------------------------------------------------

  async function playGreetingFromFile() {
    if (!GREETING_AUDIO) {
      console.warn('[Greeting] No greeting audio loaded; skipping static greeting')
      return
    }
    if (!streamSid) {
      console.warn('[Greeting] No streamSid yet; cannot play greeting')
      return
    }

    console.log('[Greeting] Playing static greeting over Twilio stream')

    // While greeting is playing, we don't want to send user audio to OpenAI
    isAssistantSpeaking = true

    const FRAME_SIZE = 160 // 20 ms per frame
    try {
      for (let i = 0; i < GREETING_AUDIO.length; i += FRAME_SIZE) {
        const chunk = GREETING_AUDIO.subarray(i, i + FRAME_SIZE)
        const b64 = chunk.toString('base64')

        twilioWs.send(
          JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: b64 },
          })
        )

        await new Promise((r) => setTimeout(r, 20))
      }
    } catch (e) {
      console.error('[Greeting] Error while streaming greeting:', e)
    } finally {
      isAssistantSpeaking = false
      console.log('[Greeting] Finished static greeting playback')
    }
  }

  // -------------------------------------------------------------------------
  // OpenAI WS
  // -------------------------------------------------------------------------

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

    // IMPORTANT:
    // We NO LONGER call the greeting prompt ("GREETING_TRIGGER").
    // The greeting is handled ONLY by the static audio we play from file.
    // So: DO NOT call any maybeSendGreeting() here.
  })

  openaiWs.on('message', async (raw) => {
    const event = JSON.parse(raw.toString())

    switch (event.type) {
      case 'response.created': {
        assistantTranscript = ''
        assistantText = ''
        break
      }

      // Ignore OpenAI's audio bytes; we only use ElevenLabs
      case 'response.audio.delta': {
        break
      }

      case 'response.audio_transcript.delta': {
        if (typeof event.delta === 'string') {
          assistantTranscript += event.delta
        }
        break
      }

      case 'response.output_text.delta': {
        if (typeof event.delta === 'string') {
          assistantText += event.delta
        }
        break
      }

      case 'response.done': {
        const textToSpeak = (assistantTranscript || assistantText || '').trim()
        if (!textToSpeak) break

        // First assistant utterance after connection would normally be the
        // router's greeting (if we still sent GREETING_TRIGGER). We have
        // removed GREETING_TRIGGER, but we keep this guard in case the prompt
        // still tries to greet anyway.
        if (!firstAssistantDone && suppressFirstAssistantUtterance) {
          console.log('[Assistant] Suppressing first assistant utterance (greeting text):', textToSpeak)
          firstAssistantDone = true
          break
        }

        console.log(`[Assistant][${currentAgent}]`, textToSpeak)
        await speakWithElevenLabs(textToSpeak)
        firstAssistantDone = true
        break
      }

      // Tools
      case 'response.output_item.added': {
        const item = event.item
        if (item?.type === 'function_call') {
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
    try {
      twilioWs.close()
    } catch {}
  })

  openaiWs.on('error', (err) => {
    console.error('[OpenAI] WS Error:', err)
    try {
      twilioWs.close()
    } catch {}
  })

  // -------------------------------------------------------------------------
  // Twilio WS
  // -------------------------------------------------------------------------

  twilioWs.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString())

      if (msg.event === 'start') {
        callSid = msg.start?.callSid || null
        streamSid = msg.start?.streamSid || null
        console.log('[Twilio] Stream Started:', callSid, 'streamSid=', streamSid)

        // As soon as we have a stream, play static greeting from file.
        // OpenAI can still be booting up in parallel.
        if (GREETING_AUDIO) {
          playGreetingFromFile().catch((e) =>
            console.error('[Greeting] Error in playGreetingFromFile:', e)
          )
        }
      }

      if (msg.event === 'media') {
        // If assistant (or greeting) is speaking, drop caller audio (no barge-in).
        if (!isAssistantSpeaking && openaiReady) {
          openaiWs.send(
            JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload,
            })
          )
        }
      }

      if (msg.event === 'stop') {
        console.log('[Twilio] Call ended', callSid)
        try {
          openaiWs.close()
        } catch {}
      }
    } catch {
      // ignore non-JSON frames
    }
  })

  twilioWs.on('close', () => {
    console.log('[WS] Twilio websocket closed')
    try {
      openaiWs.close()
    } catch {}
  })

  twilioWs.on('error', (err) => {
    console.error('[WS] Twilio WS Error:', err)
    try {
      openaiWs.close()
    } catch {}
  })

  // -------------------------------------------------------------------------
  // TOOL CALLS
  // -------------------------------------------------------------------------

  async function handleToolCall(toolName, args, callId) {
    try {
      // ---------- ROUTER TOOL ----------
      if (toolName === 'determine_route') {
        if (!ROUTER_ENDPOINT) {
          console.error('[Tool] ROUTER_ENDPOINT not configured')
          return
        }

        const resp = await axios.post(ROUTER_ENDPOINT, {
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
        } else if (output.intent === 'pickup') {
          await handleHandoff({
            handoff_from: 'router',
            intent: 'pickup',
            question_type: output.question_type || 'specific',
            question: output.cleaned_question || null,
          })
        }
        return
      }

      // ---------- ITEMS TOOL ----------
      if (toolName === 'search_items') {
        if (!ITEM_SEARCH_ENDPOINT) {
          console.error('[Tool] ITEM_SEARCH_ENDPOINT not configured')
          return
        }

        const resp = await axios.post(ITEM_SEARCH_ENDPOINT, {
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

        openaiWs.send(JSON.stringify({ type: 'response.create' }))
        return
      }

      // ---------- PICKUP TOOL ----------
      if (toolName === 'search_pickup_locations') {
        if (!PICKUP_ENDPOINT) {
          console.error('[Tool] PICKUP_ENDPOINT not configured')
          return
        }

        const resp = await axios.post(PICKUP_ENDPOINT, {
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

        openaiWs.send(JSON.stringify({ type: 'response.create' }))
        return
      }

      // ---------- HANDOFF BACK TO ROUTER ----------
      if (toolName === 'handoff_to_router') {
        const cleanedQuestion =
          typeof args.question === 'string' ? args.question : null

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
          question: cleanedQuestion,
        })

        return
      }

      console.warn('[Tool] Unknown toolName:', toolName)
    } catch (err) {
      console.error('[Tool] Error in handleToolCall', toolName, err)
    }
  }

  // -------------------------------------------------------------------------
  // AGENT SWITCHING
  // -------------------------------------------------------------------------

  async function handleHandoff(h) {
    console.log('[Handoff]', h)

    // ----- Router -> Items -----
    if (h.intent === 'items') {
      currentAgent = 'items'
      const itemsPrompt =
        PROMPTS.items || 'You are the Chasdei Lev items agent.'

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
                  properties: {
                    question: {
                      type: 'string',
                      description: 'The caller’s latest question, cleaned up.',
                    },
                  },
                  required: ['question'],
                },
              },
            ],
          },
        })
      )

      if (h.question) {
        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: h.question }],
            },
          })
        )
        openaiWs.send(JSON.stringify({ type: 'response.create' }))
      }
      return
    }

    // ----- Router -> Pickup -----
    if (h.intent === 'pickup') {
      currentAgent = 'pickup'
      const pickupPrompt =
        PROMPTS.pickup || 'You are the Chasdei Lev pickup agent.'

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
                  properties: {
                    question: {
                      type: 'string',
                      description: 'The caller’s latest question, cleaned up.',
                    },
                  },
                  required: ['question'],
                },
              },
            ],
          },
        })
      )

      if (h.question) {
        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: h.question }],
            },
          })
        )
        openaiWs.send(JSON.stringify({ type: 'response.create' }))
      }
      return
    }

    // ----- Any agent -> Router -----
    if (h.intent === 'router') {
      currentAgent = 'router'
      const routerPrompt =
        PROMPTS.router || 'You are the Chasdei Lev router agent.'

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

      if (h.question) {
        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: h.question }],
            },
          })
        )
        openaiWs.send(JSON.stringify({ type: 'response.create' }))
      }
      return
    }
  }
})
