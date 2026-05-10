/*
 * Announcement Bar - Carousel runtime.
 *
 * Custom element <sai-tl3uqxjd> that owns:
 *   - state machine for [data-state] flips (current / entering / leaving / hidden)
 *   - auto-rotate timer + focus-pause
 *   - prev/next chevrons (when chevrons_enabled)
 *   - per-slide Spectrum.Countdown timers + format + expire branches
 *   - swipe gestures with axis-dominance gate
 *   - scroll-behaviour wiring (sticky / show_on_scroll_up)
 *   - promo CTA clipboard copy + feedback (toast / inline_swap / both)
 *   - dismiss via sessionStorage (display:none, never remove)
 *   - analytics through __spectrumAi.snippet.bind
 *
 * Pure helpers exported under globalThis.__saiTl3uqxjd when
 * __SAI_TEST_HARNESS__ is true so unit tests can exercise them without
 * mounting the element.
 */
;(() => {
  const SNIPPET_ID = 'tl3uqxjd'
  const TAG_NAME = `sai-${SNIPPET_ID}`
  const TIMER_FORMATS = new Set(['DD:HH:MM:SS', 'HH:MM:SS', 'MM:SS'])
  const TIMER_EXPIRIES = new Set(['hide_slide', 'hide_bar', 'show_zeros'])
  const FEEDBACK_MODES = new Set(['toast', 'inline_swap', 'both'])
  const STORAGE_PREFIX = '__spectrum_announcement_bar_dismissed_'

  /* ────────── Pure helpers ────────── */

  /**
   * URL allowlist matching the Liquid-side check (amendment B). Accepts
   * absolute / and the http(s):, mailto:, tel: schemes. Anything else
   * including javascript:, data:, vbscript: returns null.
   */
  function validateUrl(url) {
    if (typeof url !== 'string' || url === '') return null
    if (url.charAt(0) === '/') return url
    if (url.startsWith('http://') || url.startsWith('https://')) return url
    if (url.startsWith('mailto:') || url.startsWith('tel:')) return url
    return null
  }

  /** ISO 8601 string → unix ms. Returns null on NaN / non-string. */
  function parseEpoch(iso) {
    if (typeof iso !== 'string' || iso === '') return null
    const ms = Date.parse(iso)
    return Number.isFinite(ms) ? ms : null
  }

  /**
   * Format a Spectrum.Countdown breakdown per the merchant's timer_format.
   * HH:MM:SS overflows hours past 24 (e.g. 62:23:45). MM:SS overflows minutes.
   */
  function formatTimer(format, days, hours, minutes, seconds) {
    const safe = (n) => Math.max(0, Number(n) | 0)
    const pad = (n) => String(safe(n)).padStart(2, '0')
    const padN = (n, w) => String(safe(n)).padStart(w, '0')
    if (format === 'DD:HH:MM:SS') {
      return `${pad(days)}:${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    }
    if (format === 'MM:SS') {
      const totalMin = (safe(days) * 24 + safe(hours)) * 60 + safe(minutes)
      return `${padN(totalMin, 2)}:${pad(seconds)}`
    }
    const totalHours = safe(days) * 24 + safe(hours)
    return `${padN(totalHours, 2)}:${pad(minutes)}:${pad(seconds)}`
  }

  /** Read "true"/"false" attribute with fallback. */
  function readBool(el, name, fallback) {
    const v = el.getAttribute(name)
    if (v === 'true') return true
    if (v === 'false') return false
    return fallback
  }

  /** Read numeric attribute with fallback. */
  function readNumber(el, name, fallback) {
    const v = el.getAttribute(name)
    if (v === null) return fallback
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }

  /* ────────── applyVariant — bar-level scalars only ──────────
   * Never mutates slides[] content; merchant edits to slides require
   * a fresh server render. Matches the ticker's contract.
   */
  function applyVariant(host, content) {
    if (content == null || typeof content !== 'object') return
    if (typeof content.auto_rotate === 'boolean') {
      host.setAttribute('data-auto-rotate', content.auto_rotate ? 'true' : 'false')
    }
    if (typeof content.rotation_seconds === 'number') {
      host.setAttribute('data-rotation-seconds', String(content.rotation_seconds))
    }
    if (typeof content.transition_type === 'string') {
      host.setAttribute('data-transition-type', content.transition_type)
    }
    if (typeof content.transition_duration_ms === 'number') {
      host.setAttribute('data-transition-duration-ms', String(content.transition_duration_ms))
      host.style.setProperty(
        '--sai-tl3uqxjd-transition-duration',
        `${content.transition_duration_ms}ms`,
      )
    }
    if (typeof content.swipe_enabled === 'boolean') {
      host.setAttribute('data-swipe-enabled', content.swipe_enabled ? 'true' : 'false')
    }
    if (typeof content.dismissable === 'boolean') {
      host.setAttribute('data-dismissable', content.dismissable ? 'true' : 'false')
    }
    if (typeof content.scroll_behaviour === 'string') {
      host.setAttribute('data-scroll-behaviour', content.scroll_behaviour)
    }
    if (typeof content.max_width === 'number') {
      host.setAttribute('data-max-width', String(content.max_width))
      if (content.max_width > 0) {
        host.style.setProperty('--sai-tl3uqxjd-max-width', `${content.max_width}px`)
      } else {
        host.style.removeProperty('--sai-tl3uqxjd-max-width')
      }
    }
    if (typeof content.asset_object_fit === 'string') {
      host.setAttribute('data-asset-object-fit', content.asset_object_fit)
      const assets = host.querySelectorAll('.sai-tl3uqxjd__asset')
      for (const a of assets) a.setAttribute('data-object-fit', content.asset_object_fit)
    }
    if (typeof content.asset_loop === 'boolean') {
      host.setAttribute('data-asset-loop', content.asset_loop ? 'true' : 'false')
      const videos = host.querySelectorAll('video.sai-tl3uqxjd__asset')
      for (const v of videos) {
        if (content.asset_loop) v.setAttribute('loop', '')
        else v.removeAttribute('loop')
      }
    }
    if (typeof content.promo_copied_text === 'string') {
      host.setAttribute('data-promo-copied-text', content.promo_copied_text)
    }
  }

  /* ────────── Storage (try/catch wrapped — Safari private mode safe) ────────── */

  function dismissKey(host) {
    const wrapper = host.closest('[data-spectrum-instance-id]')
    const iid = wrapper ? wrapper.getAttribute('data-spectrum-instance-id') || 'noiid' : 'noiid'
    const ver = host.getAttribute('data-bar-version') || ''
    return `${STORAGE_PREFIX}${iid}_${ver}`
  }

  function readDismissed(host) {
    try {
      return window.sessionStorage.getItem(dismissKey(host)) === '1'
    } catch (_e) {
      return false
    }
  }

  function writeDismissed(host) {
    try {
      window.sessionStorage.setItem(dismissKey(host), '1')
    } catch (_e) {
      /* graceful degradation — dismiss is per-page-load instead of per-session */
    }
  }

  /* ────────── Custom element ────────── */

  class CarouselElement extends HTMLElement {
    constructor() {
      super()
      this._currentIndex = 0
      this._slides = []
      this._countdowns = []
      this._rotationTimer = null
      this._transitioning = false
      this._pendingTarget = null
      this._paused = false
      this._track = null
      this._abortController = null
      this._intersectionObserver = null
      this._seenSlideViews = new Set()
      this._toastTimer = null
    }

    connectedCallback() {
      if (this.hasAttribute('data-sai-init')) return
      this.setAttribute('data-sai-init', '1')

      if (readDismissed(this)) {
        this.style.display = 'none'
        return
      }

      if (this.getAttribute('data-slides-warn') === 'true') {
        console.warn(
          '[announcement-bar-carousel] More than 20 slides configured. Consider splitting across multiple bars or features.',
        )
      }

      this._slides = Array.from(this.querySelectorAll('.sai-tl3uqxjd__slide'))
      if (this._slides.length === 0) return

      this._abortController = new AbortController()
      const { signal } = this._abortController

      this._setVideoPlayState()
      this._setupCountdowns()

      if (readBool(this, 'data-auto-rotate', true) && this._slides.length > 1) {
        this._startRotation()
      }

      this.addEventListener(
        'focusin',
        () => {
          this._paused = true
        },
        { signal },
      )
      this.addEventListener(
        'focusout',
        (e) => {
          if (!this.contains(e.relatedTarget)) this._paused = false
        },
        { signal },
      )

      const closeBtn = this.querySelector('.sai-tl3uqxjd__close')
      if (closeBtn) {
        closeBtn.addEventListener(
          'click',
          () => {
            writeDismissed(this)
            this._track?.('announcement_bar:dismissed', {})
            this._stopRotation()
            this._pauseAllVideos()
            this.style.display = 'none'
          },
          { signal },
        )
      }

      // Capture phase so stopPropagation here prevents the slide-level
      // click listener (attached at the slide DOM node) from firing on a
      // CTA click. Bubble-phase delegation would fire AFTER the slide's
      // own listener and the stopPropagation would be too late.
      this.addEventListener('click', (e) => this._handleCtaClick(e), { signal, capture: true })

      // Chevron prev/next clicks
      const chevrons = this.querySelectorAll('.sai-tl3uqxjd__chev')
      for (const chev of chevrons) {
        chev.addEventListener(
          'click',
          (e) => {
            e.stopPropagation()
            e.preventDefault()
            const total = this._slides.length
            if (total <= 1) return
            const dir = chev.getAttribute('data-chev')
            if (dir === 'next') this.goTo((this._currentIndex + 1) % total, 'chevron')
            else this.goTo((this._currentIndex - 1 + total) % total, 'chevron')
          },
          { signal },
        )
      }

      for (const slide of this._slides) {
        if (slide.tagName === 'DIV' && slide.hasAttribute('data-redirect-url')) {
          slide.addEventListener('click', (e) => this._handleSlideClick(e, slide), { signal })
        }
        slide.addEventListener(
          'click',
          () => {
            const idx = Number(slide.getAttribute('data-slide-index'))
            const url = slide.getAttribute('href') || slide.getAttribute('data-redirect-url') || ''
            this._track?.('announcement_bar:slide_click', {
              slide_index: idx,
              redirect_url: url,
            })
          },
          { signal },
        )
      }

      const swipeEnabled = readBool(this, 'data-swipe-enabled', true)
      if (swipeEnabled && this._slides.length > 1) {
        this._wireSwipe(signal)
      }

      this._wireScrollBehaviour(signal)
      this._wireSlideViewObserver()

      const spectrumAi = window.__spectrumAi
      if (spectrumAi?.snippet && typeof spectrumAi.snippet.bind === 'function') {
        const handle = spectrumAi.snippet.bind(this, ({ variants, currentVariantId }) => {
          const variant = variants && currentVariantId ? variants[currentVariantId] : null
          if (variant?.content) applyVariant(this, variant.content)
        })
        this._track = handle && typeof handle.track === 'function' ? handle.track : null
      }
    }

    disconnectedCallback() {
      this._stopRotation()
      if (this._abortController) {
        this._abortController.abort()
        this._abortController = null
      }
      for (const c of this._countdowns) {
        if (c?.instance) c.instance.destroy()
      }
      this._countdowns = []
      if (this._intersectionObserver) {
        this._intersectionObserver.disconnect()
        this._intersectionObserver = null
      }
      if (this._toastTimer !== null) {
        window.clearTimeout(this._toastTimer)
        this._toastTimer = null
      }
      this._pauseAllVideos()
    }

    /* ────────── Rotation ────────── */

    _startRotation() {
      const seconds = readNumber(this, 'data-rotation-seconds', 5)
      const ms = Math.max(3, seconds) * 1000
      this._rotationTimer = window.setInterval(() => {
        if (this._paused || this._transitioning) return
        const total = this._slides.length
        if (total <= 1) return
        const next = (this._currentIndex + 1) % total
        this.goTo(next, 'auto')
      }, ms)
    }

    _stopRotation() {
      if (this._rotationTimer !== null) {
        window.clearInterval(this._rotationTimer)
        this._rotationTimer = null
      }
    }

    _resetRotation() {
      if (this._rotationTimer !== null) {
        this._stopRotation()
        this._startRotation()
      }
    }

    /* ────────── Video play discipline (amendment 7) ────────── */

    _setVideoPlayState() {
      for (const slide of this._slides) {
        const idx = Number(slide.getAttribute('data-slide-index'))
        const videos = slide.querySelectorAll('video.sai-tl3uqxjd__asset')
        for (const v of videos) {
          if (idx === this._currentIndex) {
            const p = v.play()
            if (p && typeof p.catch === 'function') p.catch(() => {})
          } else {
            v.pause()
          }
        }
      }
    }

    _pauseAllVideos() {
      const videos = this.querySelectorAll('video.sai-tl3uqxjd__asset')
      for (const v of videos) v.pause()
    }

    /* ────────── Navigation (with queue-of-1) ────────── */

    goTo(target, source) {
      const total = this._slides.length
      if (total === 0) return
      if (!Number.isFinite(target) || target < 0 || target >= total) return
      if (target === this._currentIndex) return
      if (this._transitioning) {
        this._pendingTarget = target
        return
      }

      this._transitioning = true
      const from = this._currentIndex
      const to = target
      const forwardDistance = (to - from + total) % total
      const direction =
        forwardDistance === 1 ? 'next' : forwardDistance === total - 1 ? 'prev' : 'next'

      if (direction === 'prev') this.setAttribute('data-reverse', '')
      else this.removeAttribute('data-reverse')

      const fromSlide = this._slides[from]
      const toSlide = this._slides[to]

      fromSlide.setAttribute('data-state', 'leaving')
      toSlide.setAttribute('data-state', 'entering')
      toSlide.removeAttribute('inert')

      this._track?.('announcement_bar:slide_change', { from, to, source })

      if (source !== 'auto') {
        const live = this.querySelector('.sai-tl3uqxjd__live')
        if (live) {
          const label = toSlide.getAttribute('data-aria-label') || ''
          live.textContent = `Slide ${to + 1}: ${label}`
        }
      }

      const duration = readNumber(this, 'data-transition-duration-ms', 400)
      window.setTimeout(() => {
        fromSlide.setAttribute('data-state', 'hidden')
        fromSlide.setAttribute('inert', '')
        toSlide.setAttribute('data-state', 'current')
        this.removeAttribute('data-reverse')

        this._currentIndex = to
        this._setVideoPlayState()
        this._transitioning = false

        const queued = this._pendingTarget
        this._pendingTarget = null
        if (queued !== null && queued !== this._currentIndex) {
          this.goTo(queued, source)
        }

        if (source !== 'auto') this._resetRotation()
      }, duration)
    }

    /* ────────── Countdowns ────────── */

    _setupCountdowns() {
      const Countdown = window.Spectrum?.Countdown
      const timerEls = this.querySelectorAll('.sai-tl3uqxjd__timer')
      for (const timerEl of timerEls) {
        const slide = timerEl.closest('.sai-tl3uqxjd__slide')
        const slideIdx = slide ? Number(slide.getAttribute('data-slide-index')) : -1
        const isoEnd = timerEl.getAttribute('data-timer-end') || ''
        const formatRaw = timerEl.getAttribute('data-timer-format') || 'HH:MM:SS'
        const expiryRaw = timerEl.getAttribute('data-timer-expiry') || 'show_zeros'
        const format = TIMER_FORMATS.has(formatRaw) ? formatRaw : 'HH:MM:SS'
        const expiry = TIMER_EXPIRIES.has(expiryRaw) ? expiryRaw : 'show_zeros'
        const endsAt = parseEpoch(isoEnd)

        if (!Countdown || endsAt === null) {
          console.warn(
            `[announcement-bar-carousel] Skipping timer on slide ${slideIdx}: ${
              !Countdown ? 'Spectrum.Countdown unavailable' : 'invalid timer_end'
            }`,
          )
          timerEl.remove()
          this._countdowns.push(null)
          continue
        }

        const cd = new Countdown({ kind: 'epoch', endsAt })
        cd.on('tick', (state) => {
          timerEl.textContent = formatTimer(
            format,
            state.days,
            state.hours,
            state.minutes,
            state.seconds,
          )
        })
        cd.on('expire', () => {
          this._handleTimerExpire(slide, slideIdx, expiry, format, timerEl)
        })
        cd.start()
        this._countdowns.push({ idx: slideIdx, instance: cd })
      }
    }

    _handleTimerExpire(slide, slideIdx, expiry, format, timerEl) {
      this._track?.('announcement_bar:timer_expired', {
        slide_index: slideIdx,
        expiry_action: expiry,
      })

      if (expiry === 'show_zeros') {
        timerEl.textContent = formatTimer(format, 0, 0, 0, 0)
        return
      }

      if (expiry === 'hide_bar') {
        this._stopRotation()
        this._pauseAllVideos()
        this.style.display = 'none'
        return
      }

      if (slide) {
        slide.setAttribute('data-state', 'hidden')
        slide.setAttribute('inert', '')
        slide.dataset.expired = '1'
      }

      const livePool = this._slides.filter((s) => !s.dataset.expired)
      if (livePool.length === 0) {
        this._stopRotation()
        this._pauseAllVideos()
        this.style.display = 'none'
        return
      }

      if (slideIdx === this._currentIndex) {
        // Inline transition — calling goTo would overwrite the expired
        // slide's data-state="hidden" with "leaving" first. We want the
        // expired slide to stay visibly hidden+inert+expired immediately
        // and just bring the next live slide in.
        const next = livePool[0]
        const nextIdx = Number(next.getAttribute('data-slide-index'))
        if (Number.isFinite(nextIdx) && this._slides[nextIdx]) {
          const targetSlide = this._slides[nextIdx]
          targetSlide.setAttribute('data-state', 'entering')
          targetSlide.removeAttribute('inert')

          const duration = readNumber(this, 'data-transition-duration-ms', 400)
          window.setTimeout(() => {
            targetSlide.setAttribute('data-state', 'current')
            this._currentIndex = nextIdx
            this._setVideoPlayState()
          }, duration)
        }
      }
    }

    /* ────────── CTA & slide click ────────── */

    _handleCtaClick(e) {
      const btn = e.target.closest('.sai-tl3uqxjd__cta')
      if (!btn) return
      e.stopPropagation()
      e.preventDefault()
      const ctaType = btn.getAttribute('data-cta-type')
      const slideIdx = Number(btn.getAttribute('data-slide-index'))

      if (ctaType === 'redirect') {
        const url = validateUrl(btn.getAttribute('data-cta-url'))
        if (url) window.location.href = url
        return
      }

      if (ctaType === 'promo_code') {
        const code = (btn.textContent || '').trim()
        const feedbackRaw = btn.getAttribute('data-promo-feedback') || 'inline_swap'
        const feedback = FEEDBACK_MODES.has(feedbackRaw) ? feedbackRaw : 'inline_swap'
        const copiedText = this.getAttribute('data-promo-copied-text') || 'Code copied!'
        this._copyAndFeedback(code, feedback, copiedText, btn, slideIdx)
      }
    }

    _copyAndFeedback(code, feedback, copiedText, btn, slideIdx) {
      const writePromise =
        navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
          ? navigator.clipboard.writeText(code)
          : Promise.reject(new Error('clipboard API unavailable'))

      writePromise.then(
        () => {
          this._track?.('announcement_bar:promo_copied', { slide_index: slideIdx, code })
          if (feedback === 'inline_swap' || feedback === 'both') {
            const original = btn.textContent
            btn.textContent = copiedText
            window.setTimeout(() => {
              btn.textContent = original
            }, 2000)
          }
          if (feedback === 'toast' || feedback === 'both') {
            this._showToast(copiedText)
          }
        },
        () => {
          this._showToast(`Couldn't copy. Code: ${code}`)
        },
      )
    }

    _showToast(text) {
      let toast = this.querySelector('.sai-tl3uqxjd__toast')
      if (!toast) {
        toast = document.createElement('div')
        toast.className = 'sai-tl3uqxjd__toast'
        this.appendChild(toast)
      }
      toast.textContent = text
      void toast.offsetWidth
      toast.classList.add('sai-tl3uqxjd__toast--visible')
      if (this._toastTimer !== null) window.clearTimeout(this._toastTimer)
      this._toastTimer = window.setTimeout(() => {
        toast.classList.remove('sai-tl3uqxjd__toast--visible')
        this._toastTimer = null
      }, 2000)
    }

    _handleSlideClick(e, slide) {
      if (e.target.closest('.sai-tl3uqxjd__cta')) return
      if (e.target.closest('.sai-tl3uqxjd__close')) return
      const url = validateUrl(slide.getAttribute('data-redirect-url'))
      if (url) window.location.href = url
    }

    /* ────────── Swipe (axis-dominance gate, amendment 6) ────────── */

    _wireSwipe(signal) {
      const isVertical = this.getAttribute('data-transition-type') === 'slide_push_vertical'
      const MIN_DISTANCE = 30
      const RATIO = 1.5
      let startX = 0
      let startY = 0
      let active = false

      this.addEventListener(
        'touchstart',
        (e) => {
          const t = e.touches[0]
          startX = t.clientX
          startY = t.clientY
          active = true
        },
        { signal, passive: true },
      )

      this.addEventListener(
        'touchend',
        (e) => {
          if (!active) return
          active = false
          const t = e.changedTouches[0]
          const dx = t.clientX - startX
          const dy = t.clientY - startY
          const adx = Math.abs(dx)
          const ady = Math.abs(dy)
          const total = this._slides.length

          if (isVertical) {
            if (ady < MIN_DISTANCE || ady < adx * RATIO) return
            if (dy < 0) this.goTo((this._currentIndex + 1) % total, 'swipe')
            else this.goTo((this._currentIndex - 1 + total) % total, 'swipe')
          } else {
            if (adx < MIN_DISTANCE || adx < ady * RATIO) return
            if (dx < 0) this.goTo((this._currentIndex + 1) % total, 'swipe')
            else this.goTo((this._currentIndex - 1 + total) % total, 'swipe')
          }
        },
        { signal, passive: true },
      )
    }

    /* ────────── Scroll behaviour ────────── */

    _wireScrollBehaviour(signal) {
      const behaviour = this.getAttribute('data-scroll-behaviour') || 'static'
      if (behaviour !== 'show_on_scroll_up') return

      let lastY = window.scrollY
      const onScroll = () => {
        const currentY = window.scrollY
        if (currentY < lastY - 16 || currentY < 16) {
          this.classList.add('sai-tl3uqxjd--visible')
        } else if (currentY > lastY + 16) {
          this.classList.remove('sai-tl3uqxjd--visible')
        }
        lastY = currentY
      }
      window.addEventListener('scroll', onScroll, { signal, passive: true })
      if (window.scrollY < 16) this.classList.add('sai-tl3uqxjd--visible')
    }

    /* ────────── Slide view observer ────────── */

    _wireSlideViewObserver() {
      if (typeof IntersectionObserver === 'undefined') return
      this._intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
              const target = entry.target
              const idx = Number(target.getAttribute('data-slide-index'))
              if (Number.isFinite(idx) && !this._seenSlideViews.has(idx)) {
                this._seenSlideViews.add(idx)
                this._track?.('announcement_bar:slide_view', { slide_index: idx })
              }
            }
          }
        },
        { threshold: [0.5] },
      )
      for (const slide of this._slides) this._intersectionObserver.observe(slide)
    }
  }

  if (!customElements.get(TAG_NAME)) {
    customElements.define(TAG_NAME, CarouselElement)
  }

  if (typeof globalThis !== 'undefined' && globalThis.__SAI_TEST_HARNESS__) {
    globalThis.__saiTl3uqxjd = {
      validateUrl,
      parseEpoch,
      formatTimer,
      readBool,
      readNumber,
      applyVariant,
    }
  }
})()
