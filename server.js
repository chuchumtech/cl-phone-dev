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
