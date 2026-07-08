/**
 * Phase 1.23 step 11 — scene-card time row (planning doc §9.2).
 *
 * Two pieces, designed to be reused:
 *
 *   - `SceneTimeChipContent` — pure visual chip rendering a scene's
 *     pinned time data (Time of Day · Day · Season · Duration) with
 *     glyphs and accent colours. Used both inside the scene-card
 *     row's button and inside the Time Modal's Prior Scene Context
 *     section so the two surfaces look identical for the same data.
 *   - `SceneTimeRow` (default export) — the per-scene-card row:
 *     wraps the chip in a click target + clock icon. Gated on the
 *     per-story `time_tracking_enabled` master toggle. Empty state
 *     shows the access affordance with a faint "Set scene time…"
 *     placeholder so the writer always has a click target.
 *
 * Wrap behaviour is layout-aware: separators that end up first or
 * last on a wrapped line are hidden via `visibility: hidden` so the
 * reserved width keeps measurement stable (no oscillation loop).
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useUiStore } from '../../store/uiStore'
import { useMcpControlStore } from '../../store/mcpControlStore'
import { CELL_VISUALS, CellGlyph } from '../ui/TimeOfDayCarousel'
import { SeasonGlyph, SEASON_ACCENTS } from '../ui/DayCarousels'
import { useAccentColor } from '../../utils/povConstants'
import { useScenetimeWalk, sceneDurationMinutes } from '../../utils/povChainTimeWalker'
import { usePovChain } from '../../utils/povSequence'
import { useNodeDataById } from '../../hooks/useNodeDataById'
import {
  formatTimeOfDay, formatDate, formatSeason, formatSceneDuration,
  formatGap, looserTier, sceneBucket, SEASON_NAMES,
} from '../../utils/scenetimeVerbiage'

const DOT_CHAR = '·'   // mid dot (U+00B7)

// Broad-tier accent colours — match BroadPicker in TimeOfDayCarousel.
const BROAD_DAY_COLOUR   = '#f59e0b'
const BROAD_NIGHT_COLOUR = '#4338ca'

// Visual descriptor for a scene's pinned Time of Day. Combines the
// label string from `formatTimeOfDay` (canonical writer-language)
// with the chip's presentation-only metadata (glyph base/modifier,
// accent colour). The verbiage module owns the words; this helper
// owns the visual binding.
function describeTimeOfDayVisual(data, timeFormat = '12h') {
  if (!data) return null
  const tier = data.time_of_day_tier
  const label = formatTimeOfDay(data, 'value', { timeFormat })
  if (!label) return null
  if (tier === 'exact')    return { kind: 'exact', label }
  if (tier === 'labelled') {
    const visual = CELL_VISUALS[data.time_of_day_labelled]
    return {
      kind:     'labelled',
      label,
      colour:   visual?.colour,
      base:     visual?.base,
      modifier: visual?.modifier,
    }
  }
  if (tier === 'broad') {
    const isNight = data.time_of_day_broad === 'night'
    return {
      kind:    'broad',
      label,
      colour:  isNight ? BROAD_NIGHT_COLOUR : BROAD_DAY_COLOUR,
      base:    isNight ? 'moon-star' : 'noon',
      modifier: 'plain',
    }
  }
  return null
}

// Visual descriptor for a scene's pinned season — label from the
// verbiage module, glyph index + accent colour bound here.
function describeSeasonVisual(data) {
  const label = formatSeason(data)
  if (!label) return null
  const idx = SEASON_NAMES.indexOf(label)
  if (idx < 0) return null
  return {
    label,
    colour: SEASON_ACCENTS[idx],
    index:  idx,
  }
}

// Helper for callers that need to know whether anything is pinned
// without rendering the chip.
export function hasSceneTimeData(sceneData) {
  if (!sceneData) return false
  return !!(
    formatDate(sceneData)
    || formatTimeOfDay(sceneData)
    || formatSeason(sceneData)
    || formatSceneDuration(sceneData?.scene_duration)
  )
}

// Calendar glyph — vector path lifted from
// `.References/Segoe UI Symbol Regular - Calendar.svg`.
function AlarmClockIcon({ size = 11, className = '', style }) {
  return (
    <svg
      viewBox="111 250 807 910"
      width={size}
      height={size}
      aria-hidden
      className={className}
      style={style}
    >
      <path
        fill="currentColor"
        d="M595.5,326C612.833,303 632.5,284.667 654.5,271C676.5,257.333 700.833,250.5 727.5,250.5C743.833,250.5 760.833,253.417 778.5,259.25C796.167,265.083 814.667,274.667 834,288C863.667,308.333 884.917,330.083 897.75,353.25C910.583,376.417 917,400 917,424C917,439 914.833,453.833 910.5,468.5C906.167,483.167 900,497.667 892,512C875,487.667 855.75,465.167 834.25,444.5C812.75,423.833 789.417,405.583 764.25,389.75C739.083,373.917 712.25,360.583 683.75,349.75C655.25,338.917 625.833,331 595.5,326ZM525.5,1160C489.5,1160 454.75,1155.33 421.25,1146C387.75,1136.67 356.5,1123.5 327.5,1106.5C298.5,1089.5 272,1069 248,1045C224,1021 203.5,994.5 186.5,965.5C169.5,936.5 156.333,905.25 147,871.75C137.667,838.25 133,803.5 133,767.5C133,731.833 137.667,697.333 147,664C156.333,630.667 169.5,599.5 186.5,570.5C203.5,541.5 224,515 248,491C272,467 298.5,446.417 327.5,429.25C356.5,412.083 387.75,398.833 421.25,389.5C454.75,380.167 489.5,375.5 525.5,375.5C561.5,375.5 596.25,380.167 629.75,389.5C663.25,398.833 694.5,412.083 723.5,429.25C752.5,446.417 779,467 803,491C827,515 847.5,541.5 864.5,570.5C881.5,599.5 894.667,630.667 904,664C913.333,697.333 918,731.833 918,767.5C918,803.5 913.333,838.25 904,871.75C894.667,905.25 881.5,936.5 864.5,965.5C847.5,994.5 827,1021 803,1045C779,1069 752.5,1089.5 723.5,1106.5C694.5,1123.5 663.25,1136.67 629.75,1146C596.25,1155.33 561.5,1160 525.5,1160ZM525.5,462.5C483.5,462.5 443.917,470.5 406.75,486.5C369.583,502.5 337.25,524.25 309.75,551.75C282.25,579.25 260.5,611.583 244.5,648.75C228.5,685.917 220.5,725.5 220.5,767.5C220.5,795.5 224.167,822.583 231.5,848.75C238.833,874.917 249.083,899.333 262.25,922C275.417,944.667 291.25,965.333 309.75,984C328.25,1002.67 348.833,1018.67 371.5,1032C394.167,1045.33 418.5,1055.67 444.5,1063C470.5,1070.33 497.5,1074 525.5,1074C553.5,1074 580.417,1070.33 606.25,1063C632.083,1055.67 656.333,1045.33 679,1032C701.667,1018.67 722.25,1002.67 740.75,984C759.25,965.333 775.167,944.667 788.5,922C801.833,899.333 812.167,874.917 819.5,848.75C826.833,822.583 830.5,795.5 830.5,767.5C830.5,739.5 826.833,712.5 819.5,686.5C812.167,660.5 801.833,636.167 788.5,613.5C775.167,590.833 759.25,570.25 740.75,551.75C722.25,533.25 701.667,517.417 679,504.25C656.333,491.083 632.083,480.833 606.25,473.5C580.417,466.167 553.5,462.5 525.5,462.5ZM695,813L525.5,813C513.167,813 502.917,808.5 494.75,799.5C486.583,790.5 482.5,779.833 482.5,767.5L482.5,566C482.5,553.667 486.583,543.417 494.75,535.25C502.917,527.083 513.167,523 525.5,523C537.167,523 546.833,527.083 554.5,535.25C562.167,543.417 566,553.667 566,566L566,724.5L695,724.5C707.667,724.5 718.083,728.75 726.25,737.25C734.417,745.75 738.5,755.833 738.5,767.5C738.5,779.833 734.417,790.5 726.25,799.5C718.083,808.5 707.667,813 695,813ZM434.5,329.5C404.5,335.833 375.583,345 347.75,357C319.917,369 293.75,383.583 269.25,400.75C244.75,417.917 222.167,437.25 201.5,458.75C180.833,480.25 162.5,503.667 146.5,529C135.167,512.333 126.417,495.25 120.25,477.75C114.083,460.25 111,442.5 111,424.5C111,400.167 117.417,376.417 130.25,353.25C143.083,330.083 164.167,308.5 193.5,288.5C212.833,275.167 231.417,265.417 249.25,259.25C267.083,253.083 284.333,250 301,250C328,250 352.75,257.25 375.25,271.75C397.75,286.25 417.5,305.5 434.5,329.5Z"
      />
    </svg>
  )
}

function CalendarIcon({ size = 11, className = '', style }) {
  return (
    <svg
      viewBox="0 223 1024 1037"
      width={size}
      height={size}
      aria-hidden
      className={className}
      style={style}
    >
      <path
        fill="currentColor"
        d="M570.5,521L570.5,638L453.5,638L453.5,521ZM967,223C974.333,223 981.417,224.5 988.25,227.5C995.083,230.5 1001.17,234.5 1006.5,239.5C1011.83,244.5 1016.08,250.167 1019.25,256.5C1022.42,262.833 1024,269.333 1024,276L1024,1205.5C1024,1212.83 1022.42,1219.75 1019.25,1226.25C1016.08,1232.75 1011.83,1238.5 1006.5,1243.5C1001.17,1248.5 995.083,1252.5 988.25,1255.5C981.417,1258.5 974.333,1260 967,1260L54.5,1260C46.8333,1260 39.6667,1258.5 33,1255.5C26.3333,1252.5 20.5833,1248.5 15.75,1243.5C10.9167,1238.5 7.08333,1232.75 4.25,1226.25C1.41667,1219.75 0,1212.83 0,1205.5L0,276C0,261 5.08333,248.417 15.25,238.25C25.4167,228.083 38.5,223 54.5,223ZM954.5,1190L954.5,456L68.5,456L68.5,1190ZM401.5,521L401.5,638L284.5,638L284.5,521ZM906.5,521L906.5,638L789.5,638L789.5,521ZM737.5,521L737.5,638L622,638L622,521ZM570.5,689.5L570.5,805.5L453.5,805.5L453.5,689.5ZM401.5,689.5L401.5,805.5L284.5,805.5L284.5,689.5ZM233,689.5L233,805.5L117,805.5L117,689.5ZM906.5,689.5L906.5,805.5L789.5,805.5L789.5,689.5ZM737.5,689.5L737.5,805.5L622,805.5L622,689.5ZM570.5,857.5L570.5,974.5L453.5,974.5L453.5,857.5ZM401.5,857.5L401.5,974.5L284.5,974.5L284.5,857.5ZM233,857.5L233,974.5L117,974.5L117,857.5ZM906.5,857.5L906.5,974.5L789.5,974.5L789.5,857.5ZM737.5,857.5L737.5,974.5L622,974.5L622,857.5ZM570.5,1026.5L570.5,1143L453.5,1143L453.5,1026.5ZM401.5,1026.5L401.5,1143L284.5,1143L284.5,1026.5ZM233,1026.5L233,1143L117,1143L117,1026.5ZM737.5,1026.5L737.5,1143L622,1143L622,1026.5Z"
      />
    </svg>
  )
}

// Anticlockwise downwards-and-upwards open circle arrows — vector path
// lifted from `.References/Segoe UI Symbol Regular - Anticlockwise
// Downwards And Upwards Open Circle Arrows.svg`. Used as the
// time-travelling indicator when `allow_negative_time` is on and a
// scene's pinned start lands before its floor (planning §10.1.3).
function TimeTravelingIcon({ size = 14, className = '', style }) {
  return (
    <svg
      viewBox="136 216 750 1027"
      width={size}
      height={size}
      aria-hidden
      className={className}
      style={style}
    >
      <path
        fill="currentColor"
        d="M640,515.5C620.333,502.833 599.667,493.083 578,486.25C556.333,479.417 534.333,475.333 512,474L641.5,608L500,608L305.5,411L501,215.5L641.5,215.5L519.5,340C554.167,341.667 587.917,347.917 620.75,358.75C653.583,369.583 684.667,385 714,405C741,423 765.083,443.667 786.25,467C807.417,490.333 825.333,515.5 840,542.5C854.667,569.5 865.917,598 873.75,628C881.583,658 885.5,688.833 885.5,720.5C885.5,759.833 879.333,799.5 867,839.5C854.667,879.5 835.167,919.167 808.5,958.5L705.5,855C720.167,834 730.917,811.917 737.75,788.75C744.583,765.583 748,742.167 748,718.5C748,698.833 745.667,679.417 741,660.25C736.333,641.083 729.417,622.75 720.25,605.25C711.083,587.75 699.75,571.333 686.25,556C672.75,540.667 657.333,527.167 640,515.5ZM382,944C401,956.667 421.667,966.167 444,972.5C466.333,978.833 488.667,982.333 511,983L379.5,855L519.5,855L714,1048.5L519.5,1242.5L379.5,1242.5L501,1118.5C466.667,1116.5 433.167,1110.33 400.5,1100C367.833,1089.67 336.667,1074.5 307,1054.5C280,1036.17 255.917,1015.33 234.75,992C213.583,968.667 195.667,943.417 181,916.25C166.333,889.083 155.167,860.417 147.5,830.25C139.833,800.083 136,769 136,737C136,698 142,658.667 154,619C166,579.333 185,540.333 211,502L314,605.5C300,626.167 289.667,647.833 283,670.5C276.333,693.167 273,716 273,739C273,758.667 275.333,778.167 280,797.5C284.667,816.833 291.667,835.333 301,853C310.333,870.667 321.75,887.25 335.25,902.75C348.75,918.25 364.333,932 382,944Z"
      />
    </svg>
  )
}

export function ClockIcon({ size = 11, className = '', style }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      style={style}
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  )
}

// Sentence-case helper — `formatGap('compact-gap', …)` returns a
// lowercase fragment ("the next day", "5 days later"); the chip's
// leading segment reads as a standalone label so we capitalise the
// first character.
function capitalizeFirst(s) {
  if (typeof s !== 'string' || s.length === 0) return s
  return s[0].toUpperCase() + s.slice(1)
}

/**
 * Pure visual chip — segments + wrap-aware separator suppression.
 * Returns null when no time data is pinned (let caller decide
 * what to render in the empty case).
 *
 * `sceneId` + `showGapFromPrior` — when both supplied, the chip
 * leads with a dimmed segment describing the implied gap from the
 * previous POV-chain scene (e.g. "the next day", "3 hours later").
 * Only renders for non-first scenes that are on the chain.
 */
export function SceneTimeChipContent({
  sceneData,
  accentColour,
  className = '',
  sceneId = null,
  showGapFromPrior = false,
}) {
  const wrapRef = useRef(null)
  const [hiddenSepKeys, setHiddenSepKeys] = useState(() => new Set())

  // Walker access — used only when `showGapFromPrior` is on. The
  // walker hook is memoised so per-card calls don't re-walk the
  // chain. Plumbed from `useScenetimeWalk` + `usePovChain`.
  const allowNegative = useProjectStore((s) => s.story?.allow_negative_time === true)
  const timeFormat = useProjectStore((s) => (s.story?.time_format === '24h' ? '24h' : '12h'))
  const walker = useScenetimeWalk(allowNegative)
  const povChain = usePovChain()
  // Phase 4.1g follow-up — the "gap from prior" phrase needs only the
  // PRIOR scene's data, not the whole nodes array. Derive the prior
  // scene id reactively from the stable povChain, then subscribe to just
  // that scene's `data` via the shared id→node map. The old raw
  // `s.nodes` subscription re-rendered every SceneTimeRow on every
  // nodes-array write; `useNodeDataById` returns a stable `data` ref that
  // a position drag (or any unrelated node edit) never churns.
  let priorSceneId = null
  if (showGapFromPrior && sceneId) {
    const seqIdx = povChain.sequence.findIndex((s) => s.nodeId === sceneId)
    if (seqIdx > 0) priorSceneId = povChain.sequence[seqIdx - 1].nodeId
  }
  const priorSceneData = useNodeDataById(priorSceneId)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    function measure() {
      if (!wrapRef.current) return
      const children = Array.from(wrapRef.current.children)
      const tops = children.map((el) => el.getBoundingClientRect().top)
      const next = new Set()
      for (let i = 0; i < children.length; i++) {
        const el = children[i]
        if (el.dataset.sepIdx == null) continue
        const prevTop = i > 0 ? tops[i - 1] : null
        const nextTop = i < children.length - 1 ? tops[i + 1] : null
        const myTop   = tops[i]
        const isFirstOnLine = prevTop == null || prevTop !== myTop
        const isLastOnLine  = nextTop == null || nextTop !== myTop
        if (isFirstOnLine || isLastOnLine) next.add(el.dataset.sepIdx)
      }
      setHiddenSepKeys((prev) => {
        if (prev.size === next.size && [...prev].every((k) => next.has(k))) return prev
        return next
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    return () => ro.disconnect()
  })

  const day      = formatDate(sceneData)
  const tod      = describeTimeOfDayVisual(sceneData, timeFormat)
  const season   = describeSeasonVisual(sceneData)
  const duration = formatSceneDuration(sceneData?.scene_duration)
  if (!day && !tod && !season && !duration) return null

  // Compute the leading "gap from prior" phrase if requested.
  // Constraint info — appears in the chip as a dim leading segment
  // so the writer reads "[gap context] → [pinned data]." Only
  // renders when this scene is on the POV chain and has a prior.
  let gapPhrase = null
  if (showGapFromPrior && sceneId) {
    const idx = povChain.sequence.findIndex((s) => s.nodeId === sceneId)
    const thisEntry = walker.get(sceneId)
    if (idx > 0 && thisEntry && !thisEntry.isFirstScene) {
      const priorId = povChain.sequence[idx - 1].nodeId
      const priorEntry = walker.get(priorId)
      // `priorSceneData` is the prior scene's data, fetched reactively
      // above. The POV chain only ever lists sceneNodes, so a present
      // `priorSceneData` is equivalent to the old `type === 'sceneNode'`
      // guard (null when the prior was deleted out from under a stale
      // chain).
      if (priorSceneData && priorEntry) {
        // Elapsed gap = current effective start - prior end. Prior end =
        // prior effective start + duration. Matches the modal Section 3
        // visual so the chip's leading segment reads consistently with
        // what the writer sees in the time modal.
        const priorScene = priorSceneData
        const priorEnd = priorEntry.effectiveStartMinutes + (sceneDurationMinutes(priorScene) ?? 0)
        const elapsedGap = thisEntry.effectiveStartMinutes - priorEnd
        const MIN_PER_DAY = 1440
        const dayShift = Math.floor(thisEntry.effectiveStartMinutes / MIN_PER_DAY)
                       - Math.floor(priorEnd / MIN_PER_DAY)
        const priorTier = priorScene?.time_of_day_tier ?? null
        const thisTier  = sceneData?.time_of_day_tier ?? null
        const tier = looserTier(priorTier, thisTier)
        const priorWeekday = (typeof priorScene?.weekday === 'number'
          && priorScene.weekday >= 0 && priorScene.weekday <= 6) ? priorScene.weekday : null
        const currentWeekday = (typeof sceneData?.weekday === 'number'
          && sceneData.weekday >= 0 && sceneData.weekday <= 6) ? sceneData.weekday : null
        gapPhrase = capitalizeFirst(formatGap(elapsedGap, 'compact-gap', {
          tier,
          timeFormat,
          priorBucket: sceneBucket(priorScene),
          currentBucket: sceneBucket(sceneData),
          priorWeekday,
          currentWeekday,
          priorLabel: priorScene?.time_of_day_labelled ?? null,
          currentLabel: sceneData?.time_of_day_labelled ?? null,
          priorDateMonth: (typeof priorScene?.date_month === 'number') ? priorScene.date_month : null,
          priorDateDay: (typeof priorScene?.date_day_of_month === 'number') ? priorScene.date_day_of_month : null,
          currentDateMonth: (typeof sceneData?.date_month === 'number') ? sceneData.date_month : null,
          currentDateDay: (typeof sceneData?.date_day_of_month === 'number') ? sceneData.date_day_of_month : null,
          dayShift,
        }))
      }
    }
  }

  // Order: [gap from prior] → Time of Day → Day → Season → Duration.
  const segments = []
  if (gapPhrase) {
    segments.push(
      <span
        key="gap"
        className="inline-flex items-center gap-1 align-middle whitespace-nowrap text-zinc-500 italic"
      >
        {gapPhrase}
      </span>
    )
  }
  if (tod) {
    const isExact = tod.kind === 'exact'
    segments.push(
      <span key="tod" className="inline-flex items-center gap-1 align-middle whitespace-nowrap">
        {isExact ? (
          <AlarmClockIcon size={11} style={{ color: accentColour }} />
        ) : tod.base ? (
          <CellGlyph base={tod.base} modifier={tod.modifier} colour={tod.colour} size={11} />
        ) : null}
        <span style={
          isExact
            ? { color: accentColour }
            : (tod.colour ? { color: tod.colour } : undefined)
        }>
          {tod.label}
        </span>
      </span>
    )
  }
  if (day) {
    segments.push(
      <span key="day" className="inline-flex items-center gap-1 align-middle whitespace-nowrap">
        <CalendarIcon size={11} style={{ color: accentColour }} />
        <span className="text-zinc-300">{day}</span>
      </span>
    )
  }
  if (season) {
    segments.push(
      <span key="season" className="inline-flex items-center gap-1 align-middle whitespace-nowrap">
        <SeasonGlyph index={season.index} size={11} colour={season.colour} />
        <span style={{ color: season.colour }}>{season.label}</span>
      </span>
    )
  }
  if (duration) {
    segments.push(
      <span key="dur" className="inline-block align-middle whitespace-nowrap">
        <span className="text-zinc-500">Duration: </span>
        <span className="text-zinc-300">{duration}</span>
      </span>
    )
  }

  return (
    <span
      ref={wrapRef}
      className={`flex-1 min-w-0 flex flex-wrap justify-center items-center gap-y-0.5 text-[10px] leading-snug ${className}`}
    >
      {segments.flatMap((seg, i) => {
        const items = []
        if (i > 0) {
          const k = String(i)
          items.push(
            <span
              key={`sep-${i}`}
              data-sep-idx={k}
              className="text-zinc-600 mx-1.5"
              style={hiddenSepKeys.has(k) ? { visibility: 'hidden' } : undefined}
            >
              {DOT_CHAR}
            </span>
          )
        }
        items.push(
          <span key={`seg-${i}`} data-seg-idx={String(i)}>
            {seg}
          </span>
        )
        return items
      })}
    </span>
  )
}

export default function SceneTimeRow({ sceneId, sceneData }) {
  const enabled = useProjectStore((s) => s.story?.time_tracking_enabled === true)
  const allowNegative = useProjectStore((s) => s.story?.allow_negative_time === true)
  const openSceneTimeModal = useUiStore((s) => s.openSceneTimeModal)
  const accentColour = useAccentColor()
  const walker = useScenetimeWalk(allowNegative)

  if (!enabled) return null

  const hasData = hasSceneTimeData(sceneData)

  // Time-travelling indicator (planning §10.1.3): on when Allow Negative
  // Time is enabled AND this scene's effective start lands before its
  // floor. The walker only allows effective < floor when allowNegative
  // is true, so the toggle check is implicit but kept explicit here.
  const walkEntry = walker?.get?.(sceneId)
  const isTimeTravelling = !!(
    allowNegative
    && walkEntry
    && !walkEntry.isFirstScene
    && typeof walkEntry.effectiveStartMinutes === 'number'
    && typeof walkEntry.floorMinutes === 'number'
    && walkEntry.effectiveStartMinutes < walkEntry.floorMinutes
  )

  function open(e) {
    e.stopPropagation()
    // MCP session edit-lock — the time / date / duration modal is
    // an edit affordance. Suppress it during an active session so
    // user changes can't conflict with the AI's plan.
    if (useMcpControlStore.getState().sessionState === 'active') return
    openSceneTimeModal(sceneId)
  }

  return (
    <div data-help-region="scene-time-row:row" className="px-2 pb-1 pt-1 border-t border-zinc-700/60">
      <button
        type="button"
        onClick={open}
        title="Edit scene time"
        className={
          'nodrag w-full flex items-start gap-1.5 text-left rounded px-1.5 py-0.5 transition-colors ' +
          (hasData
            ? 'text-zinc-300 hover:bg-zinc-800/60'
            : 'text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800/40')
        }
      >
        <span className="flex-shrink-0 inline-flex flex-col items-center gap-0.5 mt-[2px]">
          <ClockIcon style={{ color: accentColour }} />
          {isTimeTravelling && (
            <span title="Time Traveling" className="inline-flex">
              <TimeTravelingIcon size={14} style={{ color: accentColour }} />
            </span>
          )}
        </span>
        {hasData ? (
          <SceneTimeChipContent
            sceneData={sceneData}
            accentColour={accentColour}
            sceneId={sceneId}
            showGapFromPrior
          />
        ) : (
          <span className="flex-1 text-[10px] italic text-center">Set scene time…</span>
        )}
      </button>
    </div>
  )
}
