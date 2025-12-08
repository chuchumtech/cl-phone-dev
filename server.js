// server.js
import dotenv from 'dotenv'
import http from 'http'
import WebSocket, { WebSocketServer } from 'ws'
import { supabase } from './supabaseClient.js'
import { parse as parseUrl } from 'url'
import axios from 'axios'

dotenv.config()

const {
  OPENAI_API_KEY,
  PORT = 8080,
  PROMPT_REFRESH_SECRET,
  ROUTER_ENDPOINT,
  ITEM_SEARCH_ENDPOINT,
  PICKUP_ENDPOINT, // POST endpoint for pickup lookup

  // NEW: ElevenLabs
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
if (!ROUTER_ENDPOINT) {
  console.warn('[Warn] ROUTER_ENDPOINT not set – router tool will fail.')
}
if (!ITEM_SEARCH_ENDPOINT) {
  console.warn('[Warn] ITEM_SEARCH_ENDPOINT not set – items tool will fail.')
}
if (!PICKUP_ENDPOINT) {
  console.warn('[Warn] PICKUP_ENDPOINT not set – pickup tool will fail.')
}
if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
  console.warn('[Warn] ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID not set – TTS will fail.')
}

// ---------------------------------------------------------------------------
// 1. PROMPT CACHE
// ---------------------------------------------------------------------------

const PROMPTS = {
  router: '',
  items: '',
  pickup: '',
}

async function reloadPromptsFromDB() {
  try {
    const { data, error } = await supabase
      .from('cl_phone_agents')
      .select('slug, system_prompt')
      .in('slug', ['router-dev', 'item-dev', 'locations'])

    if (error) {
      console.error('[Prompts] Error loading from DB:', error)
      return
    }

    for (const row of data || []) {
      if (row.slug === 'router-dev') PROMPTS.router = row.system_prompt || ''
      if (row.slug === 'item-dev') PROMPTS.items = row.system_prompt || ''
      if (row.slug === 'locations') PROMPTS.pickup = row.system_prompt || ''
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

// Initial load on startup
await reloadPromptsFromDB()

// ---------------------------------------------------------------------------
// 2. HTTP SERVER (for /refresh-prompts)
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

// ---------------------------------------------------------------------------
// 3. WS SERVER (Twilio <-> OpenAI Realtime + ElevenLabs TTS)
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer })

httpServer.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT} (HTTP + WS)`)
})

wss.on('connection', async (twilioWs, req) => {
  const { pathname } = parseUrl(req.url || '', true)
  if (pathname !== '/twilio-stream') {
    console.log('[WS] Unknown path:', pathname)
    twilioWs.close()
    return
  }

  console.log('[WS] New Twilio media stream connection')

  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  )

  // Per-call state
  let isAssistantSpeaking = false
  let currentAgent = 'router'
  let callSid = null
  let streamSid = null
  let openaiReady = false
  let twilioStarted = false
  let greetingSent = false

  // Response + logging helpers
  let responseActive = false
  let currentAssistantText = '' // text we will send to ElevenLabs

  // Map of function_call call_id -> toolName
  const functionCallMap = new Map()

  function maybeSendGreeting() {
    if (!openaiReady || !twilioStarted || greetingSent) return

    greetingSent = true
    console.log('[Greeting] Sending GREETING_TRIGGER to OpenAI')

    openaiWs.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'GREETING_TRIGGER' }],
        },
      })
    )

    openaiWs.send(JSON.stringify({ type: 'response.create' }))
  }

  // --------------- ElevenLabs TTS helper ----------------

  async function speakWithElevenLabs(text) {
    if (!streamSid) {
      console.warn('[TTS] No streamSid, cannot send audio to Twilio')
      return
    }
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
      console.warn('[TTS] ElevenLabs env vars missing, skipping TTS')
      return
    }
    if (!text || !text.trim()) return

    try {
      isAssistantSpeaking = true
      console.log('[TTS] Synthesizing text with ElevenLabs:', text)

      const modelId = ELEVENLABS_MODEL_ID || 'eleven_monolingual_v1'

      // Request μ-law 8kHz audio suitable for Twilio
      const ttsResp = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
        {
          text,
          model_id: modelId,
          // You can tune stability / clarity here as needed
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.85,
          },
        },
        {
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            Accept: 'audio/mulaw', // μ-law 8kHz (ElevenLabs supports Twilio-style)
            'Content-Type': 'application/json',
          },
          responseType: 'arraybuffer',
        }
      )

      const audioBuffer = Buffer.from(ttsResp.data)

      // Twilio media stream: send small chunks (e.g. 160 bytes ~= 20 ms at 8kHz)
      const FRAME_SIZE = 160
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
      }
    } catch (err) {
      console.error('[TTS] Error calling ElevenLabs:', err?.response?.data || err)
    } finally {
      isAssistantSpeaking = false
    }
  }

  // ---------------- OpenAI WS: on open ----------------

  openaiWs.on('open', () => {
    console.log('[OpenAI] Realtime session opened')

    const routerPrompt =
      PROMPTS.router || 'You are the Chasdei Lev router agent.'

    openaiWs.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          instructions: routerPrompt,
          // We still accept audio input from Twilio to OpenAI,
          // but we ignore OpenAI's audio output and synthesize with ElevenLabs.
          modalities: ['audio', 'text'],
          // voice param not really used anymore, but harmless
          voice: 'cedar',
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
    maybeSendGreeting()
  })

  // ---------------- Twilio -> OpenAI ----------------

  twilioWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())

      if (msg.event === 'start') {
        callSid = msg.start?.callSid || null
        streamSid = msg.start?.streamSid || null
        console.log('[Twilio] Call started', callSid, 'streamSid=', streamSid)
        twilioStarted = true
        maybeSendGreeting()
      }

      if (msg.event === 'media') {
        // Only send caller audio to OpenAI when assistant is not speaking
        if (!isAssistantSpeaking) {
          openaiWs.send(
            JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload, // base64 g711_ulaw from Twilio
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

  // ---------------- OpenAI -> Twilio (via ElevenLabs TTS) ----------------

   // ---------------- OpenAI -> Twilio (via ElevenLabs TTS) ----------------

  openaiWs.on('message', async (raw) => {
    const event = JSON.parse(raw.toString())

    switch (event.type) {
      // ---- RESPONSE LIFECYCLE ----
      case 'response.created': {
        responseActive = true
        // We'll build the full utterance from the transcript
        currentAssistantText = ''
        break
      }

      // We IGNORE OpenAI audio bytes now; all audio comes from ElevenLabs.
      case 'response.audio.delta': {
        // Do nothing here on purpose
        break
      }

      // Build up the assistant's spoken text from the transcript stream
      case 'response.audio_transcript.delta': {
        if (typeof event.delta === 'string') {
          currentAssistantText += event.delta
        }
        break
      }

      // When the transcript for this response is done, send it to ElevenLabs
      case 'response.audio_transcript.done': {
        const textToSpeak = currentAssistantText.trim()
        if (textToSpeak) {
          console.log(`[Assistant][${currentAgent}]`, textToSpeak)
          await speakWithElevenLabs(textToSpeak)
        }
        currentAssistantText = ''
        responseActive = false
        // speakWithElevenLabs flips isAssistantSpeaking on/off around playback
        break
      }

      case 'response.audio.done': {
        // We ignore OpenAI audio; ElevenLabs already handled playback.
        break
      }

      case 'response.done': {
        // We already handled speaking on transcript.done
        break
      }

      // ---- FUNCTION CALL LIFECYCLE ----
      case 'response.output_item.added': {
        const item = event.item
        if (item?.type === 'function_call') {
          const toolName = item.name
          const callId = item.call_id
          if (callId && toolName) {
            functionCallMap.set(callId, toolName)
            console.log('[Tool] function_call started', callId, toolName)
          }
        }
        break
      }

      case 'response.function_call_arguments.delta': {
        // ignore partials
        break
      }

      case 'response.function_call_arguments.done': {
        const callId = event.call_id
        const argsJson = event.arguments || '{}'
        let args = {}
        try {
          args = JSON.parse(argsJson)
        } catch (e) {
          console.error('[Tool] Failed to parse arguments JSON:', e, argsJson)
        }

        const toolName = functionCallMap.get(callId)
        if (!toolName) {
          console.warn('[Tool] Unknown call_id:', callId)
          break
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
  // 4. HANDOFF DETECTOR (JSON handoffs via text, if ever used)
// ---------------------------------------------------------------------------

  function looksLikeHandoff(text) {
    try {
      const obj = JSON.parse(text)
      return obj && obj.intent && obj.handoff_from
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // 5. TOOL CALL HANDLING
// ---------------------------------------------------------------------------

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
        // orders etc can be added later
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

        // Items agent will generate text → ElevenLabs TTS will speak it
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

      // ---------- HANDOFF TO ROUTER TOOL ----------
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
  // 6. AGENT SWITCHING (router <-> items / pickup)
// ---------------------------------------------------------------------------

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
                  properties: {
                    query: { type: 'string' },
                  },
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
                      description:
                        'The caller’s latest question, cleaned up but without changing the meaning.',
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
                  properties: {
                    location_query: { type: 'string' },
                  },
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
                      description:
                        'The caller’s latest question, cleaned up but without changing the meaning.',
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
