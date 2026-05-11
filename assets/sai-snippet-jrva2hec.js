/**
 * Announcement Bar - Ticker (jrva2hec) snippet-author runtime.
 *
 * Drives the marquee animation duration and pause gestures for each
 * `[data-spectrum-instance-id][data-spectrum-snippet-id="jrva2hec"]`
 * container on the page.
 *
 * Animation itself is CSS — `@keyframes sai-jrva2hec-marquee` translates the
 * track from 0 to -50% over `--sai-jrva2hec-duration`. The browser compositor
 * runs the animation; this module only sets the duration value (so pixel
 * speed stays constant regardless of total slide width) and pauses on
 * gesture / focus / reduced-motion.
 *
 * Positioning is intentionally not a snippet concern. The host renders in
 * normal flow; whichever section / template places the bar decides whether
 * to wrap it in a sticky / fixed container.
 *
 * applyVariant updates DOM attributes and classes for bar-level scalars on
 * every variant resolution. Downstream effects vary:
 *
 *   - `ticker_seconds`     → updates `data-ticker-seconds`; setDuration()
 *                            re-reads the attribute on each invocation, and
 *                            the bind callback calls it after applyVariant
 *                            so the marquee speed picks up the new value.
 *   - `asset_object_fit`   → updates the `data-object-fit` attribute on
 *                            every asset; CSS reads it live.
 *   - `asset_loop`         → toggles the `loop` attribute on <video>; live.
 *   - `pause_on_hover`     → updates the `data-pause-on-hover` attribute,
 *                            so CSS hover-pause responds live. The focus /
 *                            touch listeners however are wired once at init
 *                            based on the initial value — flipping this at
 *                            runtime won't add or remove those listeners.
 *
 * Slide content (the JSON array) is server-rendered and not mutable here —
 * a variant rule that changes slide text or assets requires a fresh page
 * render.
 *
 * Test surface: when `globalThis.__SAI_TEST_HARNESS__ === true`, exposes
 * `globalThis.__saiJrva2hec` with `{ applyVariant, computeDuration }` for
 * unit tests.
 */
;(() => {
  const SNIPPET_ID = 'jrva2hec'
  const ROOT_SELECTOR = `.sai-${SNIPPET_ID}`
  const TRACK_SELECTOR = `.sai-${SNIPPET_ID}__track`
  const VIEWPORT_SELECTOR = `.sai-${SNIPPET_ID}__viewport`
  const COPY_SELECTOR = `.sai-${SNIPPET_ID}__track-copy`
  const VALID_OBJECT_FITS = new Set(['cover', 'contain', 'fill', 'none'])

  /**
   * Compute the marquee animation duration. `tickerSeconds` is "seconds for
   * one viewport-width of slide content to scroll past." The animation
   * actually moves the track by one full copy's width (translate -50% of
   * the 2-copy track), so duration scales with content length to keep
   * pixels-per-second constant regardless of slide count.
   */
  function computeDuration(tickerSeconds, copyWidth, viewportWidth) {
    if (!Number.isFinite(tickerSeconds) || tickerSeconds <= 0) return null
    if (!Number.isFinite(copyWidth) || copyWidth <= 0) return null
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return null
    return tickerSeconds * (copyWidth / viewportWidth)
  }

  function readBoolAttr(node, name, fallback) {
    const value = node.getAttribute(name)
    if (value === 'true') return true
    if (value === 'false') return false
    return fallback
  }

  function readNumberAttr(node, name, fallback) {
    const raw = node.getAttribute(name)
    if (raw === null || raw === '') return fallback
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  function applyVariant(node, content) {
    const root = node.querySelector(ROOT_SELECTOR)
    const track = node.querySelector(TRACK_SELECTOR)
    if (!root || !track) return

    if (typeof content.ticker_seconds === 'number') {
      root.setAttribute('data-ticker-seconds', String(content.ticker_seconds))
    }

    if (typeof content.pause_on_hover === 'boolean') {
      const v = content.pause_on_hover ? 'true' : 'false'
      root.setAttribute('data-pause-on-hover', v)
      track.setAttribute('data-pause-on-hover', v)
    }

    if (
      typeof content.asset_object_fit === 'string' &&
      VALID_OBJECT_FITS.has(content.asset_object_fit)
    ) {
      const assets = node.querySelectorAll(`.sai-${SNIPPET_ID}__asset`)
      for (const a of assets) a.setAttribute('data-object-fit', content.asset_object_fit)
    }

    if (typeof content.asset_loop === 'boolean') {
      const videos = node.querySelectorAll(`.sai-${SNIPPET_ID}__asset`)
      for (const v of videos) {
        if (v.tagName === 'VIDEO') {
          if (content.asset_loop) v.setAttribute('loop', '')
          else v.removeAttribute('loop')
        }
      }
    }
  }

  if (globalThis.__SAI_TEST_HARNESS__ === true) {
    globalThis.__saiJrva2hec = {
      applyVariant,
      computeDuration,
      readBoolAttr,
      readNumberAttr,
    }
  }

  /**
   * Set up one container's runtime: animation duration,
   * pause-on-focus/touch, click and view analytics. Returns a teardown
   * function.
   */
  function activateContainer(node, snippetApi) {
    const root = node.querySelector(ROOT_SELECTOR)
    const track = node.querySelector(TRACK_SELECTOR)
    const viewport = node.querySelector(VIEWPORT_SELECTOR)
    const firstCopy = node.querySelector(COPY_SELECTOR)
    if (!root || !track || !viewport || !firstCopy) return () => {}

    // pauseOnHover is captured once at init — flipping it via applyVariant
    // updates the data attribute (CSS hover-pause responds live) but does
    // not add or remove the focus / touch listeners.
    const pauseOnHover = readBoolAttr(root, 'data-pause-on-hover', true)

    const reducedMotion =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null

    const track_ = track
    const viewport_ = viewport
    const firstCopy_ = firstCopy

    // When the natural slide content is shorter than the viewport, the
    // duplicate-track marquee would scroll empty space between cycles.
    // Clone the snapshot of original children additively (1× per iteration)
    // until the copy is at least as wide as the viewport. Snapshotting
    // ONCE up-front matters: re-reading copy.children each iteration grows
    // the clone count exponentially (2, 4, 8 …) and a single zero-width
    // child would lock the page at 2^32 clones before the safety cap.
    function fillCopiesToViewport() {
      const viewportWidth = viewport_.getBoundingClientRect().width
      if (!viewportWidth) return
      const copies = node.querySelectorAll(COPY_SELECTOR)
      for (const copy of copies) {
        const originals = Array.from(copy.children)
        if (originals.length === 0) continue
        let safety = 32
        while (copy.getBoundingClientRect().width < viewportWidth && safety-- > 0) {
          const widthBefore = copy.getBoundingClientRect().width
          for (const child of originals) {
            copy.appendChild(child.cloneNode(true))
          }
          // If a full pass over the original children didn't widen the
          // copy at all, the children render at zero width — bail rather
          // than burn the remaining safety budget on no-op appends.
          if (copy.getBoundingClientRect().width <= widthBefore) break
        }
      }
    }
    fillCopiesToViewport()

    function setDuration() {
      if (reducedMotion?.matches) return
      // Re-read each call so applyVariant's data-ticker-seconds update is
      // picked up without needing to thread state.
      const tickerSeconds = readNumberAttr(root, 'data-ticker-seconds', 30)
      const copyWidth = firstCopy_.getBoundingClientRect().width
      const viewportWidth = viewport_.getBoundingClientRect().width
      const duration = computeDuration(tickerSeconds, copyWidth, viewportWidth)
      if (duration === null) return
      track_.style.setProperty(`--sai-${SNIPPET_ID}-duration`, `${duration}s`)
    }

    // On viewport widen (browser resize, mobile rotate, devtools toggle), an
    // earlier copy that was wide enough may now expose blank space at -50%.
    // Re-fill before recomputing duration so the marquee never animates over
    // an under-wide track.
    function onResize() {
      fillCopiesToViewport()
      setDuration()
    }
    setDuration()

    // Flip the host's data-ready attribute so CSS unpauses the animation.
    // This must happen AFTER setDuration so the marquee starts at the
    // correct speed; otherwise it would briefly run at the default duration
    // and snap-restart when JS updates the value.
    root.setAttribute('data-ready', 'true')

    let resizeObserver = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(onResize)
      resizeObserver.observe(firstCopy_)
      resizeObserver.observe(viewport_)
    } else {
      window.addEventListener('resize', onResize)
    }

    const onMotionChange = () => {
      if (reducedMotion?.matches) {
        track_.style.setProperty(`--sai-${SNIPPET_ID}-duration`, '0s')
      } else {
        setDuration()
      }
    }
    if (reducedMotion && typeof reducedMotion.addEventListener === 'function') {
      reducedMotion.addEventListener('change', onMotionChange)
    }
    onMotionChange()

    let getTrack = null
    function fireAnalytics(eventName, payload) {
      if (!getTrack) return
      try {
        getTrack(eventName, payload)
      } catch {
        // Analytics is best-effort — never let a tracking error break the bar.
      }
    }

    function pause(reason) {
      track_.style.animationPlayState = 'paused'
      fireAnalytics('announcement_bar:pause', { reason })
    }
    function resume(reason) {
      // Clear the inline property rather than setting 'running'. The CSS
      // `:hover` rule has no `!important`, so an inline `running` would
      // permanently outrank it — once a keyboard or touch interaction
      // routed through resume(), hover-pause would stop working for the
      // rest of the page lifetime. Removing the inline property hands
      // control back to CSS (which handles both hover-pause and the
      // data-ready running state).
      track_.style.removeProperty('animation-play-state')
      fireAnalytics('announcement_bar:resume', { reason })
    }

    const focusListeners = []
    if (pauseOnHover) {
      const onFocusIn = () => pause('focus')
      const onFocusOut = () => resume('focus_end')
      const onTouchStart = () => pause('touch')
      const onTouchEnd = () => resume('touch_end')
      node.addEventListener('focusin', onFocusIn)
      node.addEventListener('focusout', onFocusOut)
      node.addEventListener('touchstart', onTouchStart, { passive: true })
      node.addEventListener('touchend', onTouchEnd, { passive: true })
      focusListeners.push(
        ['focusin', onFocusIn],
        ['focusout', onFocusOut],
        ['touchstart', onTouchStart],
        ['touchend', onTouchEnd],
      )
    }

    // Click analytics — delegate on the container so newly-rendered slides
    // (after applyVariant) are covered.
    function onClick(event) {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      const slideEl = target.closest(`.sai-${SNIPPET_ID}__slide`)
      if (!slideEl || !node.contains(slideEl)) return
      const idx = Number(slideEl.getAttribute('data-slide-index') || '0')
      const href = slideEl.getAttribute('href') || ''
      fireAnalytics('announcement_bar:slide_click', {
        slide_index: idx,
        redirect_url: href,
      })
    }
    node.addEventListener('click', onClick)

    // IntersectionObserver — emit slide_view exactly once per slide on the
    // first time it crosses 50% visibility. We observe the FIRST copy only;
    // the duplicated copy is decorative.
    let intersectionObserver = null
    const reportedViews = new Set()
    if (typeof IntersectionObserver !== 'undefined') {
      intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting || entry.intersectionRatio < 0.5) continue
            const idx = entry.target.getAttribute('data-slide-index')
            if (idx === null || reportedViews.has(idx)) continue
            reportedViews.add(idx)
            fireAnalytics('announcement_bar:slide_view', {
              slide_index: Number(idx),
            })
          }
        },
        { threshold: [0, 0.5, 1], root: viewport_ },
      )
      const slidesToObserve = firstCopy_.querySelectorAll(`.sai-${SNIPPET_ID}__slide`)
      for (const s of slidesToObserve) intersectionObserver.observe(s)
    }

    function teardown() {
      if (resizeObserver) resizeObserver.disconnect()
      else window.removeEventListener('resize', onResize)
      if (reducedMotion && typeof reducedMotion.removeEventListener === 'function') {
        reducedMotion.removeEventListener('change', onMotionChange)
      }
      for (const [evt, fn] of focusListeners) node.removeEventListener(evt, fn)
      node.removeEventListener('click', onClick)
      if (intersectionObserver) intersectionObserver.disconnect()
    }

    return {
      teardown,
      setTrackHandle: (track) => {
        getTrack = track
      },
      // Re-compute marquee duration. Called by the bind callback after
      // applyVariant updates `data-ticker-seconds` so the new speed takes
      // effect without a page reload.
      refreshDuration: setDuration,
    }
  }

  function init() {
    const containers = document.querySelectorAll(
      `[data-spectrum-instance-id][data-spectrum-snippet-id="${SNIPPET_ID}"]`,
    )
    const snippetApi = window.__spectrumAi?.snippet

    for (const node of containers) {
      const handle = activateContainer(node, snippetApi)
      if (!handle || typeof handle.teardown !== 'function') continue

      // Wire to the SDK if available; otherwise the bar runs without analytics
      // and without runtime variant resolution (SSR is enough for both).
      if (snippetApi && typeof snippetApi.bind === 'function') {
        const bound = snippetApi.bind(node, ({ variants, currentVariantId }) => {
          const variant = variants.find((v) => v.variantId === currentVariantId)
          if (!variant || !variant.content) return
          applyVariant(node, variant.content)
          // applyVariant only updates the data attribute; setDuration reads
          // it live, so re-running here lets `ticker_seconds` changes take
          // effect on variant switch without a page reload.
          handle.refreshDuration()
        })
        if (bound && typeof bound.track === 'function') {
          handle.setTrackHandle(bound.track)
        }
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true })
  } else {
    init()
  }
})()
