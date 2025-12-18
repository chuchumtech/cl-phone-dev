// server.js (FULL REWRITE)
// Twilio Media Streams <-> OpenAI Realtime (text+tools) + ElevenLabs (TTS)
// Plays a static pre-recorded greeting.ulaw immediately on Twilio WS start.
// Prevents "conversation_already_has_active_response" by queuing response.create.
// Only generates answers after OpenAI VAD says the caller stopped speaking.

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
// 1. LOAD STATIC GREETING AUDIO (RAW µ-law 8kHz, NO WAV HEADER)
// ---------------------------------------------------------------------------
// IMPORTANT:
// - This MUST be raw G.711 µ-law at 8000 Hz, mono (NOT mp3, NOT m4a, NOT wav header).
// - Put it in your repo so Render deploy includes it.
// - Recommended file name: ./greeting.ulaw
//
// Convert from m4a (iPhone Voice Memo) like:
//   ffmpeg -i greeting.m4a -ar 8000 -ac 1 -f mulaw -acodec pcm_mulaw greeting.ulaw
//

let GREETING_AUDIO = null
let GREETING_FRAMES_B64 = null
try {
  GREETING_AUDIO = fs.readFileSync('./greeting.ulaw')
  console.log('[Greeting] Loaded greeting.ulaw, bytes=', GREETING_AUDIO.length)

  const FRAME_SIZE = 160 // 20 ms @ 8kHz µ-law
  GREETING_FRAMES_B64 = []
  for (let i = 0; i < GREETING_AUDIO.length; i += FRAME_SIZE) {
    GREETING_FRAMES_B64.push(GREETING_AUDIO.subarray(i, i + FRAME_SIZE).toString('base64'))
  }
} catch (e) {
  console.error('[Greeting] Failed to load ./greeting.ulaw:', e.message)
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

httpServer.listen(Number(PORT), '0.0.0.0', () => {
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

  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  })

  // ----------------------------
  // Per-call state
  // ----------------------------
  let callSid = null
  let streamSid = null

  let openaiReady = false

  // "speaking" blocks barge-in and prevents response.create from audio
  let isAssistantSpeaking = false
  let isGreetingPlaying = false

  let currentAgent = 'router'

  // Response lifecycle control (prevents conversation_already_has_active_response)
  let responseInProgress = false
  let pendingResponseCreate = false

  // Only speak when a response was actually requested because of user speech/tool followup
  let lastResponseIntent = null // 'vad' | 'handoff' | 'tool-followup'

  // Text accumulation from OpenAI (we use this to send to ElevenLabs)
  let assistantTranscript = ''
  let assistantText = ''

  // Tool call mapping
  const functionCallMap = new Map()

  // ----------------------------
  // Small helpers
  // ----------------------------

  function safeSendOpenAI(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify(obj))
    }
  }

  function requestResponseCreate(reason) {
    lastResponseIntent = reason

    if (!openaiReady) return

    if (responseInProgress) {
      pendingResponseCreate = true
      return
    }

    safeSendOpenAI({ type: 'response.create' })
  }

  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  // -------------------------------------------------------------------------
  // Static greeting playback (raw µ-law frames)
  // -------------------------------------------------------------------------
  async function playGreeting() {
    if (!GREETING_FRAMES_B64 || !streamSid) return
    console.log('[Greeting] Playing static greeting over Twilio stream')

    isGreetingPlaying = true
    isAssistantSpeaking = true

    try {
      // 20 ms pacing per frame to keep it real-time and clean
      for (const b64 of GREETING_FRAMES_B64) {
        twilioWs.send(
          JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: b64 },
          })
        )
        await sleep(20)
      }
    } catch (e) {
      console.error('[Greeting] Error streaming greeting:', e)
    } finally {
      isGreetingPlaying = false
      isAssistantSpeaking = false
      console.log('[Greeting] Finished static greeting playback')
    }
  }

  // -------------------------------------------------------------------------
  // ElevenLabs TTS (dynamic responses)
  // -------------------------------------------------------------------------
  async function speakWithElevenLabs(text) {
    if (!text || !text.trim()) return
    if (!streamSid) {
      console.warn('[TTS] No streamSid yet, skipping TTS')
      return
    }

    try {
      isAssistantSpeaking = true
      console.log(`[ElevenLabs] Synthesizing: "${text.substring(0, 80)}..."`)

      const modelId = ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5'

      const resp = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=ulaw_8000`,
        {
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.8,
            similarity_boost: 0.0,
            style: 0.25,
            speed: 0.95,
          },
        },
        {
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
          },
          responseType: 'arraybuffer',
          timeout: 20000,
        }
      )

      const audio = Buffer.from(resp.data)
      const FRAME_SIZE = 160 // 20 ms @ 8kHz µ-law

      // Real-time pacing prevents distortion/buffer weirdness
      for (let i = 0; i < audio.length; i += FRAME_SIZE) {
        const chunk = audio.subarray(i, i + FRAME_SIZE)
        const b64 = chunk.toString('base64')
        twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }))
        await sleep(20)
      }
    } catch (e) {
      console.error('[ElevenLabs] TTS Error:', e?.response?.data || e?.message || e)
    } finally {
      isAssistantSpeaking = false
    }
  }

  // -------------------------------------------------------------------------
  // OpenAI session configuration per agent
  // -------------------------------------------------------------------------
  function setRouterSession() {
    currentAgent = 'router'
    const routerPrompt = PROMPTS.router || 'You are the Chasdei Lev router agent.'

    safeSendOpenAI({
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
  }

  function setItemsSession() {
    currentAgent = 'items'
    const itemsPrompt = PROMPTS.items || 'You are the Chasdei Lev items agent.'

    safeSendOpenAI({
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
            description: 'Return control to the router agent when the caller asks about something other than items.',
            parameters: {
              type: 'object',
              properties: { question: { type: 'string' } },
              required: ['question'],
            },
          },
        ],
      },
    })
  }

  function setPickupSession() {
    currentAgent = 'pickup'
    const pickupPrompt = PROMPTS.pickup || 'You are the Chasdei Lev pickup agent.'

    safeSendOpenAI({
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
            description: 'Return control to the router agent when the caller asks about something other than pickup.',
            parameters: {
              type: 'object',
              properties: { question: { type: 'string' } },
              required: ['question'],
            },
          },
        ],
      },
    })
  }

  // -------------------------------------------------------------------------
  // Agent switching / handoff
  // -------------------------------------------------------------------------
  async function handleHandoff(h) {
    console.log('[Handoff]', h)

    if (h.intent === 'items') {
      setItemsSession()

      if (h.question) {
        safeSendOpenAI({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: h.question }],
          },
        })
        requestResponseCreate('handoff')
      }
      return
    }

    if (h.intent === 'pickup') {
      setPickupSession()

      if (h.question) {
        safeSendOpenAI({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: h.question }],
          },
        })
        requestResponseCreate('handoff')
      }
      return
    }

    if (h.intent === 'router') {
      setRouterSession()

      if (h.question) {
        safeSendOpenAI({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: h.question }],
          },
        })
        requestResponseCreate('handoff')
      }
      return
    }
  }

  // -------------------------------------------------------------------------
  // Tool call handler
  // -------------------------------------------------------------------------
  async function handleToolCall(toolName, args, callId) {
    try {
      // Safety: handle a couple of hallucinated tool names gracefully
      if (toolName === 'handoff_to_items') toolName = 'determine_route'
      if (toolName === 'handoff_to_pickup') toolName = 'determine_route'

      if (toolName === 'determine_route') {
        if (!ROUTER_ENDPOINT) {
          console.error('[Tool] ROUTER_ENDPOINT not configured')
          return
        }

        const resp = await axios.post(
          ROUTER_ENDPOINT,
          {
            ...args,
            call_sid: callSid,
            current_agent: currentAgent,
          },
          { timeout: 15000 }
        )

        const output = resp.data || {}

        safeSendOpenAI({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify(output),
          },
        })

        // Router should hand off ONLY to items/pickup; others stay router and speak fallback.
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

        // For orders/meta/unknown, the router prompt should speak the correct line.
        // We DO NOT force another response.create here because the model is already in a response.
        return
      }

      if (toolName === 'search_items') {
        if (!ITEM_SEARCH_ENDPOINT) {
          console.error('[Tool] ITEM_SEARCH_ENDPOINT not configured')
          return
        }

        const resp = await axios.post(
          ITEM_SEARCH_ENDPOINT,
          { ...args, call_sid: callSid },
          { timeout: 15000 }
        )

        const output = resp.data || {}

        safeSendOpenAI({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify(output),
          },
        })

        // IMPORTANT:
        // Do NOT send response.create here.
        // The OpenAI response that requested the tool is still active; sending response.create causes
        // "conversation_already_has_active_response".
        return
      }

      if (toolName === 'search_pickup_locations') {
        if (!PICKUP_ENDPOINT) {
          console.error('[Tool] PICKUP_ENDPOINT not configured')
          return
        }

        const resp = await axios.post(
          PICKUP_ENDPOINT,
          { ...args, call_sid: callSid },
          { timeout: 15000 }
        )

        const output = resp.data || {}

        safeSendOpenAI({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify(output),
          },
        })

        // Do NOT send response.create here (same reason as above)
        return
      }

      if (toolName === 'handoff_to_router') {
        const cleanedQuestion = typeof args.question === 'string' ? args.question : null

        safeSendOpenAI({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({ ok: true }),
          },
        })

        await handleHandoff({
          handoff_from: currentAgent,
          intent: 'router',
          question_type: 'specific',
          question: cleanedQuestion,
        })

        return
      }

      console.warn('[Tool] Unknown toolName:', toolName)
    } catch (e) {
      console.error('[Tool] Error in handleToolCall', toolName, e?.response?.data || e)
    }
  }

  // -------------------------------------------------------------------------
  // OpenAI WS events
  // -------------------------------------------------------------------------
  openaiWs.on('open', () => {
    console.log('[OpenAI] Connected')
    openaiReady = true

    // Always start on Router instructions (router should NOT greet; greeting is your .ulaw file)
    setRouterSession()
  })

  openaiWs.on('message', async (raw) => {
    let event
    try {
      event = JSON.parse(raw.toString())
    } catch {
      return
    }

    switch (event.type) {
      // Gate: only answer after caller finished speaking
      case 'input_audio_buffer.speech_stopped': {
        // Ignore if we are currently playing greeting or speaking TTS
        if (isAssistantSpeaking || isGreetingPlaying) break
        requestResponseCreate('vad')
        break
      }

      case 'response.created': {
        responseInProgress = true
        assistantTranscript = ''
        assistantText = ''
        break
      }

      case 'response.audio.delta': {
        // ignored; we use ElevenLabs
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

      case 'response.output_item.added': {
        const item = event.item
        if (item?.type === 'function_call') {
          if (item.call_id && item.name) {
            functionCallMap.set(item.call_id, item.name)
            console.log('[Tool] function_call started', item.call_id, item.name)
          }
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
        responseInProgress = false

        // If we queued a response.create during an active response, send it now.
        if (pendingResponseCreate) {
          pendingResponseCreate = false
          requestResponseCreate(lastResponseIntent || 'vad')
        }

        const textToSpeak = (assistantTranscript || assistantText || '').trim()

        // Only speak if we have real content AND we were triggered by user speech/handoff.
        if (!textToSpeak) break
        if (!lastResponseIntent) break

        // Extra guard: router sometimes tries to say identity/meta immediately; let it speak normally.
        console.log(`[Assistant][${currentAgent}]`, textToSpeak)
        await speakWithElevenLabs(textToSpeak)

        // Reset so we don’t speak “extra” followups unless another VAD stop/handoff happens.
        lastResponseIntent = null
        break
      }

      case 'error': {
        // Do not crash; log and keep going
        console.error('[OpenAI error event]', event)
        // If the error is active_response, we rely on our queueing; nothing else needed here.
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
  // Twilio WS events
  // -------------------------------------------------------------------------
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
      console.log('[Twilio] Stream Started:', callSid, 'streamSid=', streamSid)

      // Play greeting immediately; OpenAI boots in parallel.
      if (GREETING_FRAMES_B64?.length) {
        playGreeting().catch((e) => console.error('[Greeting] playGreeting error:', e))
      }
      return
    }

    if (msg.event === 'media') {
      // No-barge-in: drop user audio while we are playing greeting or speaking TTS
      if (isAssistantSpeaking || isGreetingPlaying) return
      if (!openaiReady) return

      safeSendOpenAI({
        type: 'input_audio_buffer.append',
        audio: msg.media.payload,
      })
      return
    }

    if (msg.event === 'stop') {
      console.log('[Twilio] Call ended', callSid)
      try {
        openaiWs.close()
      } catch {}
      return
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
})
