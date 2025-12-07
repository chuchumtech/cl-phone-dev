import { supabase } from './supabaseClient.js'

export async function speakAnswer(key, params = {}) {
  const { data, error } = await supabase
    .from('answer_templates')
    .select('spoken_template')
    .eq('key', key)
    .eq('is_active', true)
    .single()

  if (error || !data) {
    console.error('[Answers] Missing template for key:', key, error)
    return "I don't have an answer configured for that yet."
  }

  let text = data.spoken_template

  // very simple {{var}} interpolation
  for (const [k, v] of Object.entries(params)) {
    const safeVal = v == null ? '' : String(v)
    text = text.replaceAll(`{{${k}}}`, safeVal)
  }

  return text
}
