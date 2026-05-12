/*
 * Announcement Bar - Carousel runtime.
 *
 * Custom element <sai-tl3uqxjd> that owns:
 *   - state machine for [data-state] flips (current / entering / leaving / hidden)
 *   - auto-rotate timer + focus-pause
 *   - prev/next chevrons (when chevrons_enabled)
 *   - per-slide Spectrum.Countdown timers + format + expire branches
 *   - swipe gestures with axis-dominance gate
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
   * including javascript:, data:, vbscript: returns null. The `//`
   * leading-pair check rejects protocol-relative URLs (`//evil.com`)
   * which browsers resolve to the page's protocol and would silently
   * navigate off-site.
   */
  function validateUrl(url) {
    if (typeof url !== 'string' || url === '') return null
    if (url.startsWith('//')) return null
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
  // Whitelists for client-side enum scrubbing in applyVariant — mirrors
  // the Liquid-side scrub so a buggy Studio control can't slip junk into
  // a data attribute.
  const VALID_TRANSITION_TYPES = new Set(['fade', 'slide_push_horizontal', 'slide_push_vertical'])
  const VALID_OBJECT_FITS = new Set(['cover', 'contain', 'fill', 'none'])

  function clampNumber(value, min, max, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(Math.max(value, min), max)
  }

  function applyVariant(host, content) {
    if (content == null || typeof content !== 'object') return
    let rotationChanged = false
    if (typeof content.auto_rotate === 'boolean') {
      host.setAttribute('data-auto-rotate', content.auto_rotate ? 'true' : 'false')
      rotationChanged = true
    }
    if (typeof content.rotation_seconds === 'number') {
      const seconds = clampNumber(content.rotation_seconds, 3, 60, 5)
      host.setAttribute('data-rotation-seconds', String(seconds))
      rotationChanged = true
    }
    if (
      typeof content.transition_type === 'string' &&
      VALID_TRANSITION_TYPES.has(content.transition_type)
    ) {
      host.setAttribute('data-transition-type', content.transition_type)
      // CSS keyframe selectors are anchored on the `sai-tl3uqxjd--transition-<type>`
      // modifier class (Liquid-baked at SSR), not on `data-transition-type`. Strip
      // every known variant before adding the new one so the animation actually
      // swaps when Studio live-previews a different transition.
      for (const t of VALID_TRANSITION_TYPES) {
        host.classList.remove(`sai-tl3uqxjd--transition-${t}`)
      }
      host.classList.add(`sai-tl3uqxjd--transition-${content.transition_type}`)
    }
    if (typeof content.transition_duration_ms === 'number') {
      const ms = clampNumber(content.transition_duration_ms, 100, 2000, 400)
      host.setAttribute('data-transition-duration-ms', String(ms))
      host.style.setProperty('--sai-tl3uqxjd-transition-duration', `${ms}ms`)
    }
    if (typeof content.swipe_enabled === 'boolean') {
      host.setAttribute('data-swipe-enabled', content.swipe_enabled ? 'true' : 'false')
    }
    if (typeof content.dismissable === 'boolean') {
      host.setAttribute('data-dismissable', content.dismissable ? 'true' : 'false')
    }
    if (typeof content.max_width === 'number') {
      const mw = clampNumber(content.max_width, 0, 2000, 0)
      host.setAttribute('data-max-width', String(mw))
      if (mw > 0) {
        host.style.setProperty('--sai-tl3uqxjd-max-width', `${mw}px`)
      } else {
        host.style.removeProperty('--sai-tl3uqxjd-max-width')
      }
    }
    if (typeof content.max_height === 'number') {
      const mh = clampNumber(content.max_height, 0, 400, 0)
      host.setAttribute('data-max-height', String(mh))
      if (mh > 0) {
        host.style.setProperty('--sai-tl3uqxjd-max-height', `${mh}px`)
      } else {
        host.style.removeProperty('--sai-tl3uqxjd-max-height')
      }
    }
    if (
      typeof content.asset_object_fit === 'string' &&
      VALID_OBJECT_FITS.has(content.asset_object_fit)
    ) {
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
      return true
    } catch (e) {
      // sessionStorage write can fail under Safari private mode, quota
      // pressure, sandboxed iframes, etc. "Fail loud, never fake" — log a
      // single console warn so a merchant chasing "users keep seeing
      // dismissed bars" has something to triage.
      console.warn(
        '[announcement-bar-carousel] sessionStorage write failed; dismiss will not persist',
        e,
      )
      return false
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
      this._countdownPoll = null
      this._goToTimer = null
      this._expireTimer = null
      this._transitioning = false
      this._pendingTarget = null
      this._paused = false
      this._track = null
      this._abortController = null
      this._intersectionObserver = null
      this._seenSlideViews = new Set()
      this._barInView = false
      this._toast = null
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
          (e) => {
            // CTA clicks fire `cta_*` events; close clicks fire `dismissed`.
            // Skip the slide_click event for those so analytics don't
            // double-count the user's intent.
            if (e.target.closest('.sai-tl3uqxjd__cta')) return
            if (e.target.closest('.sai-tl3uqxjd__close')) return
            const idx = Number(slide.getAttribute('data-slide-index'))
            const url = slide.getAttribute('href') || slide.getAttribute('data-redirect-url') || ''
            this._track?.('announcement_bar:slide_click', {
              slide_index: Number.isFinite(idx) ? idx : -1,
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

      this._wireSlideViewObserver()

      const spectrumAi = window.__spectrumAi
      if (spectrumAi?.snippet && typeof spectrumAi.snippet.bind === 'function') {
        const handle = spectrumAi.snippet.bind(this, ({ variants, currentVariantId }) => {
          // Boundary with third-party SDK code — wrap in try/catch so a
          // malformed payload (variants shape drift, etc.) doesn't propagate
          // up through bind's dispatch and break everything else on the page.
          try {
            // `variants` is an array of SnippetBindVariant; look up by id.
            const variant =
              Array.isArray(variants) && currentVariantId
                ? variants.find((v) => v?.variantId === currentVariantId)
                : null
            if (variant?.content) {
              applyVariant(this, variant.content)
              // Rotation interval is captured at setInterval-time, so a live
              // edit to auto_rotate / rotation_seconds via Studio doesn't take
              // effect until the next page load unless we tear down + restart.
              const hadRotation =
                'auto_rotate' in variant.content || 'rotation_seconds' in variant.content
              if (hadRotation) {
                this._stopRotation()
                if (readBool(this, 'data-auto-rotate', true) && this._slides.length > 1) {
                  this._startRotation()
                }
              }
            }
          } catch (err) {
            console.error('[announcement-bar-carousel] Variant binding failed', err)
            this._track?.('announcement_bar:variant_bind_failed', {
              error: String(err?.message ?? err),
            })
          }
        })
        if (handle && typeof handle.track === 'function') {
          this._track = handle.track
        } else {
          console.warn(
            '[announcement-bar-carousel] Bootstrap SDK returned handle without track(); analytics disabled',
          )
          this._track = null
        }
      } else {
        // Bootstrap SDK missing entirely — most likely the artifacts loader
        // failed (CSP / ad-blocker / loader regression). The bar still
        // renders the default variant, but variants + analytics are gone.
        // Fail loud so a merchant has something to triage.
        console.error(
          '[announcement-bar-carousel] window.__spectrumAi.snippet.bind unavailable; analytics + runtime variants disabled',
        )
      }
    }

    disconnectedCallback() {
      this._stopRotation()
      if (this._countdownPoll !== null) {
        window.clearInterval(this._countdownPoll)
        this._countdownPoll = null
      }
      if (this._goToTimer !== null) {
        window.clearTimeout(this._goToTimer)
        this._goToTimer = null
      }
      if (this._expireTimer !== null) {
        window.clearTimeout(this._expireTimer)
        this._expireTimer = null
      }
      if (this._abortController) {
        this._abortController.abort()
        this._abortController = null
      }
      for (const c of this._countdowns) {
        if (c?.instance) {
          try {
            c.instance.destroy()
          } catch (err) {
            console.warn('[announcement-bar-carousel] Countdown destroy failed', err)
          }
        }
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
      // Toast lives in document.body — must be explicitly removed; the
      // AbortController teardown doesn't reach it.
      if (this._toast?.isConnected) {
        this._toast.remove()
      }
      this._toast = null
      this._pauseAllVideos()
      // Reset transient state so a future re-init (HMR / Studio iframe
      // reload) doesn't read leftover values.
      this._slides = []
      this._currentIndex = 0
      this._transitioning = false
      this._pendingTarget = null
      this._paused = false
      this._seenSlideViews.clear()
      this._track = null
    }

    /* ────────── Rotation ────────── */

    _startRotation() {
      const seconds = readNumber(this, 'data-rotation-seconds', 5)
      const ms = Math.max(3, seconds) * 1000
      this._rotationTimer = window.setInterval(() => {
        if (this._paused || this._transitioning) return
        const total = this._slides.length
        if (total <= 1) return
        // Walk forward over expired-via-timer slides so the bar doesn't sit
        // for `rotation_seconds` on a hidden+inert slide showing the bg.
        let next = -1
        for (let step = 1; step <= total; step++) {
          const candidate = (this._currentIndex + step) % total
          if (!this._slides[candidate].dataset.expired) {
            next = candidate
            break
          }
        }
        if (next >= 0 && next !== this._currentIndex) this.goTo(next, 'auto')
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
            // Bump preload BEFORE play() so the browser fetches the buffer
            // before trying to start playback. SSR ships preload="none" to
            // avoid warming buffers for every slide at page-load (LCP win
            // on carousels with many video slides).
            v.preload = 'auto'
            const p = v.play()
            if (p && typeof p.catch === 'function') {
              p.catch((err) => {
                // NotAllowedError is the autoplay policy ("user gesture
                // required") — expected on most browsers, swallow silently.
                // Anything else (NotSupportedError, AbortError, MediaError,
                // decode/CORS failure) means the merchant's video URL is
                // broken — surface it.
                if (err && err.name === 'NotAllowedError') return
                console.warn('[announcement-bar-carousel] Video play failed', {
                  src: v.currentSrc,
                  slide_index: idx,
                  error_name: err?.name,
                  error_message: err?.message,
                })
                this._track?.('announcement_bar:video_play_failed', {
                  slide_index: idx,
                  src: v.currentSrc,
                  error_name: err?.name ?? 'unknown',
                })
              })
            }
          } else {
            v.pause()
            // Drop the preload hint so the browser can release buffer for
            // off-screen videos. Already-cached bytes stay in the HTTP
            // cache; this only frees the in-memory decode buffer.
            v.preload = 'none'
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
      this._fireSlideView(to)

      if (source !== 'auto') {
        const live = this.querySelector('.sai-tl3uqxjd__live')
        if (live) {
          const label = toSlide.getAttribute('data-aria-label') || ''
          live.textContent = `Slide ${to + 1}: ${label}`
        }
      }

      const duration = readNumber(this, 'data-transition-duration-ms', 400)
      this._goToTimer = window.setTimeout(() => {
        this._goToTimer = null
        // disconnectedCallback may have run while we were mid-transition;
        // operating on detached DOM leaks work and can resurrect video
        // state on a node nobody can see.
        if (!this.isConnected) return
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

    /**
     * Sync fast path when `Spectrum.Countdown` is already on `window`. When
     * the carousel script (loaded `async`) beats the SDK script (loaded
     * `defer`), we poll for up to 5 seconds and then run setup. Without this
     * wait, every timer element would be silently removed on fast cold loads.
     * Returns early when no timer elements are present so a carousel with
     * zero timers doesn't burn 100 setInterval ticks waiting for an SDK it
     * doesn't need.
     */
    _setupCountdowns() {
      if (this.querySelectorAll('.sai-tl3uqxjd__timer').length === 0) return
      const ctor = window.Spectrum?.Countdown
      if (ctor) {
        this._setupCountdownsWith(ctor)
        return
      }
      const start = Date.now()
      this._countdownPoll = window.setInterval(() => {
        // disconnectedCallback aborts the controller; the setInterval
        // callback may still be queued from before the disconnect — bail
        // so we don't operate on detached DOM.
        if (!this.isConnected || this._abortController?.signal.aborted) {
          window.clearInterval(this._countdownPoll)
          this._countdownPoll = null
          return
        }
        const ready = window.Spectrum?.Countdown
        if (ready) {
          window.clearInterval(this._countdownPoll)
          this._countdownPoll = null
          this._setupCountdownsWith(ready)
          return
        }
        if (Date.now() - start >= 5000) {
          window.clearInterval(this._countdownPoll)
          this._countdownPoll = null
          this._setupCountdownsWith(null)
        }
      }, 50)
    }

    _setupCountdownsWith(Countdown) {
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
          const reason = !Countdown ? 'sdk_unavailable' : 'invalid_end'
          console.warn(
            `[announcement-bar-carousel] Skipping timer on slide ${slideIdx}: ${
              !Countdown ? 'Spectrum.Countdown unavailable' : 'invalid timer_end'
            }`,
          )
          // Surface to analytics — merchant deploys a countdown, it silently
          // vanishes from prod, they have no diagnostic without telemetry.
          this._track?.('announcement_bar:timer_skipped', {
            slide_index: slideIdx,
            reason,
            raw_end: isoEnd,
          })
          timerEl.remove()
          // Push null to keep array dense by index for positional lookup.
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
        // and just bring the next live slide in. Walk forward from the
        // expired slide so the bar advances in the natural direction
        // (livePool[0] could be BEFORE the current index → bar jumps
        // backwards).
        const total = this._slides.length
        let nextIdx = -1
        for (let step = 1; step <= total; step++) {
          const candidate = (slideIdx + step) % total
          if (!this._slides[candidate].dataset.expired) {
            nextIdx = candidate
            break
          }
        }
        if (nextIdx >= 0) {
          const targetSlide = this._slides[nextIdx]
          targetSlide.setAttribute('data-state', 'entering')
          targetSlide.removeAttribute('inert')

          // Hold the FSM lock for the duration so an auto-rotate tick or
          // chevron/swipe click can't fire a parallel goTo mid-flight
          // (which would flip data-state on both slides and visibly
          // stutter). Mirrors goTo's queue-of-1 pattern.
          this._transitioning = true

          const duration = readNumber(this, 'data-transition-duration-ms', 400)
          this._expireTimer = window.setTimeout(() => {
            this._expireTimer = null
            if (!this.isConnected) {
              this._transitioning = false
              return
            }
            targetSlide.setAttribute('data-state', 'current')
            this._currentIndex = nextIdx
            this._setVideoPlayState()
            this._transitioning = false

            // Drain any goTo that was attempted while we held the lock.
            const queued = this._pendingTarget
            this._pendingTarget = null
            if (queued !== null && queued !== this._currentIndex) {
              this.goTo(queued, 'auto')
            }
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
        const raw = btn.getAttribute('data-cta-url')
        const url = validateUrl(raw)
        if (url) {
          window.location.href = url
          return
        }
        // Allowlist rejected the merchant URL — surface so a stuck CTA
        // ("button does nothing") has a diagnostic.
        console.warn('[announcement-bar-carousel] CTA URL rejected by allowlist', {
          raw_url: raw,
          slide_index: slideIdx,
        })
        this._track?.('announcement_bar:cta_url_rejected', {
          slide_index: slideIdx,
          raw_url: raw,
        })
        return
      }

      if (ctaType === 'promo_code') {
        // Read from data-promo-code, NOT textContent — textContent gets
        // swapped to "Code copied!" for 2s after a successful copy, so a
        // re-click within that window would otherwise copy the feedback
        // string instead of the real code. Fall back to textContent if the
        // attribute is missing (older SSR / hand-written wrappers).
        const code = (btn.getAttribute('data-promo-code') || btn.textContent || '').trim()
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
            // Restore from the stable code attribute — re-read at restore
            // time so any future applyVariant patch to data-promo-code is
            // reflected; falls back to the captured closure value if the
            // attribute was stripped between click and timeout.
            btn.textContent = copiedText
            window.setTimeout(() => {
              btn.textContent = btn.getAttribute('data-promo-code') || code
            }, 2000)
          }
          if (feedback === 'toast' || feedback === 'both') {
            this._showToast(copiedText)
          }
        },
        (err) => {
          // Clipboard API can fail on HTTP origins, sandboxed iframes,
          // permission-blocked, very old browsers. The toast surfaces to
          // the user; the warn + telemetry surface to the merchant.
          console.warn('[announcement-bar-carousel] Clipboard write failed', err)
          this._track?.('announcement_bar:promo_copy_failed', {
            slide_index: slideIdx,
            code,
            error_name: err?.name ?? 'unknown',
          })
          this._showToast(`Couldn't copy. Code: ${code}`)
        },
      )
    }

    _showToast(text) {
      // Append to document.body — NOT this host — so the toast escapes
      // the host's `overflow: hidden` (which clips rail transitions).
      // The element keeps the `sai-tl3uqxjd__toast` class so the aggregate
      // CSS still styles it. Track the reference so disconnectedCallback
      // can remove it (preventing orphan toasts on Studio iframe reloads).
      let toast = this._toast
      if (!toast || !toast.isConnected) {
        toast = document.createElement('div')
        toast.className = 'sai-tl3uqxjd__toast'
        document.body.appendChild(toast)
        this._toast = toast
      }
      toast.textContent = text
      // Force a layout flush so the `--visible` class transition fires
      // even when the element was just created (otherwise the browser
      // batches both the insert and the class add into one paint).
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
      const raw = slide.getAttribute('data-redirect-url')
      const url = validateUrl(raw)
      if (url) {
        window.location.href = url
        return
      }
      // Allowlist rejected the merchant URL — surface so a stuck slide
      // ("background click does nothing") has a diagnostic.
      const idx = Number(slide.getAttribute('data-slide-index'))
      console.warn('[announcement-bar-carousel] Slide redirect URL rejected by allowlist', {
        raw_url: raw,
        slide_index: idx,
      })
      this._track?.('announcement_bar:slide_url_rejected', {
        slide_index: Number.isFinite(idx) ? idx : -1,
        raw_url: raw,
      })
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

    /* ────────── Slide view observer ──────────
     *
     * All slides share the same grid cell, so per-slide IntersectionObserver
     * fires for every slide on first paint (geometry is identical; opacity
     * doesn't count toward intersectionRatio). Instead, observe the HOST to
     * detect when the bar enters the viewport, then fire `slide_view` from
     * `_fireSlideView` driven by goTo + initial connect — that path knows
     * which slide is actually `current`.
     */
    _wireSlideViewObserver() {
      if (typeof IntersectionObserver === 'undefined') return
      this._intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
              this._barInView = true
              // Fire the deferred initial view (slide 0) now that the bar
              // is actually visible.
              this._fireSlideView(this._currentIndex)
            } else if (!entry.isIntersecting) {
              this._barInView = false
            }
          }
        },
        { threshold: [0.5] },
      )
      this._intersectionObserver.observe(this)
    }

    _fireSlideView(idx) {
      if (!this._barInView) return
      if (!Number.isFinite(idx)) return
      if (this._seenSlideViews.has(idx)) return
      this._seenSlideViews.add(idx)
      this._track?.('announcement_bar:slide_view', { slide_index: idx })
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
