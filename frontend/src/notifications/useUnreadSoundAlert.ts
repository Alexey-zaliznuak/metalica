import { useEffect, useRef } from 'react'

const BEEP_INTERVAL_MS = 12_000

function playUnreadBeep(audioCtx: AudioContext) {
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume()
  }
  const now = audioCtx.currentTime
  const gain = audioCtx.createGain()
  gain.connect(audioCtx.destination)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35)

  // Два коротких тона — заметнее одного «пика» в фоне.
  for (const [offset, freq] of [
    [0, 880],
    [0.12, 1175],
  ] as const) {
    const osc = audioCtx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    osc.connect(gain)
    osc.start(now + offset)
    osc.stop(now + offset + 0.1)
  }
}

/**
 * Пока есть непрочитанные и опция включена — периодический звуковой сигнал.
 * AudioContext разблокируется при первом жесте пользователя (ограничение браузеров).
 */
export function useUnreadSoundAlert(enabled: boolean, unreadCount: number) {
  const audioCtxRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    const unlock = () => {
      if (!audioCtxRef.current) {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext
        if (!Ctx) return
        audioCtxRef.current = new Ctx()
      }
      void audioCtxRef.current.resume()
    }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  useEffect(() => {
    if (!enabled || unreadCount <= 0) {
      return
    }

    const tick = () => {
      try {
        if (!audioCtxRef.current) {
          const Ctx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext
          if (!Ctx) return
          audioCtxRef.current = new Ctx()
        }
        playUnreadBeep(audioCtxRef.current)
      } catch {
        /* автоплей мог быть заблокирован до жеста пользователя */
      }
    }

    tick()
    const timer = window.setInterval(tick, BEEP_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [enabled, unreadCount])
}
