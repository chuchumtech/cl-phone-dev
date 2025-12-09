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
// 1. PROMPT CACHE
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

    // Reset prompts
    PROMPTS.router = ''
    PROMPTS.items = ''
    PROMPTS.pickup = ''

    for (const row of data || []) {
      if (row.slug === 'router-dev') PROMPTS.router = row.system_prompt || ''
      if (row.slug === 'item-dev') PROMPTS.items = row.system_prompt || ''
      if (row.slug === 'locations-dev') PROMPTS.pickup = row.system_prompt || ''
    }
    console.log('[Prompts] Reloaded active prompts')
  } catch (e) {
    console.error('[Prompts] Unexpected error reloading:', e)
  }
}

await reloadPromptsFromDB()

// ---------------------------------------------------------------------------
// 2. HTTP SERVER
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
// 3. WS SERVER
// ---------------------------------------------------------------------------

wss.on('connection', async (twilioWs, req) => {
  const { pathname } = parseUrl(req.url || '', true)
  if (pathname !== '/twilio-stream') {
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
  let greetingSent = false
  
  // Audio Queue for Race Conditions (Fixes Silent Greeting)
  const audioQueue = [] 

  let assistantTranscript = ''
  let assistantText = ''
  const functionCallMap = new Map()

  function maybeSendGreeting() {
    if (!openaiReady || greetingSent) return
    greetingSent = true
    console.log('[Greeting] Triggering OpenAI Greeting...')

    openaiWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'GREETING_TRIGGER' }],
      },
    }))
    openaiWs.send(JSON.stringify({ type: 'response.create' }))
  }

  // --------------- ElevenLabs TTS Helper ----------------

  async function speakWithElevenLabs(text) {
    if (!text || !text.trim()) return

    try {
      isAssistantSpeaking = true
      console.log(`[ElevenLabs] Synthesizing: "${text.substring(0, 20)}..."`)

      const modelId = ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5' 

      // CRITICAL FIX: ?output_format=ulaw_8000 ensures no static noise
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=ulaw_8000`,
        {
          text,
          model_id: modelId,
          voice_settings: { stability: 0.76, similarity_boost: 0.65, style: 0.2, speed: 0.85 },
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
      const FRAME_SIZE = 160 // 160 bytes = 20ms of audio at 8kHz mulaw
      
      // Chunking loop to simulate streaming to Twilio
      for (let i = 0; i < audioBuffer.length; i += FRAME_SIZE) {
        const chunk = audioBuffer.subarray(i, i + FRAME_SIZE)
        const b64 = chunk.toString('base64')
        
        const mediaMsg = {
            event: 'media',
            streamSid: streamSid,
            media: { payload: b64 }
        }

        if (streamSid) {
            // If we have the ID, send immediately
            twilioWs.send(JSON.stringify(mediaMsg))
        } else {
            // CRITICAL FIX: Buffer audio if Twilio isn't ready yet (Silent Greeting Fix)
            audioQueue.push(mediaMsg)
        }
        
        // Slight pacing to prevent flooding Twilio buffer
        await new Promise(r => setTimeout(r, 10))
      }

    } catch (err) {
      console.error('[ElevenLabs] TTS Error:', err.message)
    } finally {
      isAssistantSpeaking = false
    }
  }

  // ---------------- OpenAI WS ----------------

  openaiWs.on('open', () => {
    console.log('[OpenAI] Connected')
    const routerPrompt = PROMPTS.router || 'You are the Chasdei Lev router agent.'

    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: routerPrompt,
        // We need audio input (to hear user), but we ignore OpenAI audio output
        modalities: ['audio', 'text'],
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: { type: 'server_vad' },
        tools: [
            {
                type: 'function',
                name: 'determine_route',
                description: 'Classify caller intent for Chasdei Lev phone calls and decide which agent should handle it.',
                parameters: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' },
                        ai_classification: { type: 'string' },
                    },
                    required: ['message', 'ai_classification'],
                },
            }
        ],
      },
    }))

    openaiReady = true
    maybeSendGreeting()
  })

  openaiWs.on('message', async (raw) => {
    const event = JSON.parse(raw.toString())

    switch (event.type) {
      case 'response.created':
        assistantTranscript = ''
        assistantText = ''
        break

      // Ignore OpenAI Audio (We use ElevenLabs)
      case 'response.audio.delta': 
        break

      // Capture Transcript
      case 'response.audio_transcript.delta':
        if (event.delta) assistantTranscript += event.delta
        break
      
      // Capture Text (Fallback)
      case 'response.output_text.delta':
        if (event.delta) assistantText += event.delta
        break

      case 'response.done': {
        const textToSpeak = (assistantTranscript || assistantText || '').trim()
        if (textToSpeak) {
            await speakWithElevenLabs(textToSpeak)
        }
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
        if (toolName) {
           await handleToolCall(toolName, JSON.parse(event.arguments), callId)
        }
        break
      }
    }
  })

  // ---------------- Twilio WS ----------------

  twilioWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())

      if (msg.event === 'start') {
        callSid = msg.start?.callSid
        streamSid = msg.start?.streamSid
        console.log('[Twilio] Stream Started:', streamSid)

        // CRITICAL FIX: Flush buffered Greeting audio to the new Stream
        while (audioQueue.length > 0) {
            const bufferedMsg = audioQueue.shift()
            bufferedMsg.streamSid = streamSid
            twilioWs.send(JSON.stringify(bufferedMsg))
        }
      }

      if (msg.event === 'media') {
        // "No-Barge-In" Logic:
        // If Assistant is speaking (fetching or streaming TTS), we drop user audio.
        if (!isAssistantSpeaking) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload,
          }))
        }
      }

      if (msg.event === 'stop') {
        openaiWs.close()
      }
    } catch {}
  })

  twilioWs.on('close', () => openaiWs.close())

  // ---------------- Logic ----------------

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

        // Send output to OpenAI
        openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify(output),
            },
        }))

        // Handle routing logic based on API response
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

        openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify(output),
            },
        }))

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

        openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify(output),
            },
        }))

        openaiWs.send(JSON.stringify({ type: 'response.create' }))
        return
      }

      // ---------- HANDOFF TOOL (Agent to Router) ----------
      if (toolName === 'handoff_to_router') {
        const cleanedQuestion = typeof args.question === 'string' ? args.question : null

        openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify({ ok: true }),
            },
        }))

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

  // ---------------- AGENT SWITCHING ----------------

  async function handleHandoff(h) {
    console.log('[Handoff]', h)

    // ----- Router -> Items -----
    if (h.intent === 'items') {
      currentAgent = 'items'
      const itemsPrompt = PROMPTS.items || 'You are the Chasdei Lev items agent.'

      openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions: itemsPrompt,
            tools: [
              {
                type: 'function',
                name: 'search_items',
                description: 'Search the Chasdei Lev items database and answer kashrus and package questions based ONLY on the provided data.',
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
                  properties: {
                    question: { type: 'string', description: 'The caller’s latest question, cleaned up.' },
                  },
                  required: ['question'],
                },
              },
            ],
          },
      }))

      if (h.question) {
        openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: h.question }],
            },
        }))
        openaiWs.send(JSON.stringify({ type: 'response.create' }))
      }
      return
    }

    // ----- Router -> Pickup -----
    if (h.intent === 'pickup') {
      currentAgent = 'pickup'
      const pickupPrompt = PROMPTS.pickup || 'You are the Chasdei Lev pickup agent.'

      openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions: pickupPrompt,
            tools: [
              {
                type: 'function',
                name: 'search_pickup_locations',
                description: 'Search the Chasdei Lev distribution locations database.',
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
                  properties: {
                    question: { type: 'string', description: 'The caller’s latest question, cleaned up.' },
                  },
                  required: ['question'],
                },
              },
            ],
          },
      }))

      if (h.question) {
        openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: h.question }],
            },
        }))
        openaiWs.send(JSON.stringify({ type: 'response.create' }))
      }
      return
    }

    // ----- Any agent -> Router -----
    if (h.intent === 'router') {
      currentAgent = 'router'
      const routerPrompt = PROMPTS.router || 'You are the Chasdei Lev router agent.'

      openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions: routerPrompt,
            tools: [
              {
                type: 'function',
                name: 'determine_route',
                description: 'Classify caller intent for Chasdei Lev phone calls and decide which agent should handle it.',
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
      }))

      if (h.question) {
        openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: h.question }],
            },
        }))
        openaiWs.send(JSON.stringify({ type: 'response.create' }))
      }
      return
    }
  }
})
