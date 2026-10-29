export const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window

export function speak(text: string, lang: 'en-US' | 'ru-RU') {
  if (!canSpeak) return
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = lang
  window.speechSynthesis.speak(utterance)
}
