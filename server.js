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
