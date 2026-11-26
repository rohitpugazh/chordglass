// Page layouts for the 576x288 display. Pure: state in, Page out.
//
// Every page has a blank full-screen text box underneath that receives
// gestures (a box whose text overflows scrolls instead of passing swipes on).

import { eventAt, sections, type Chart } from '../chart/chart'
import { CHORD_IMG_H, CHORD_IMG_W, renderChordPng } from '../glasses/chordImage'
import type { ImageBox, MenuItem, Page, TextBox } from '../glasses/screen'
import { approxPx, bar, clipPx, fitItems, mmss } from '../glasses/text'
import { tuningAdvice, tuningNotes } from '../theory/tuning'
import { keyLine, setupLine, type SongInfo } from './songinfo'

export const W = 576
export const H = 288

export const MENU = {
  record: 1,
  transposeUp: 2,
  transposeDown: 3,
  resetSync: 4,
  info: 5,
  bigChord: 6,
  reload: 7,
  saveRecording: 11,
  discardRecording: 12,
  restartRecording: 13,
} as const

const evt = (): TextBox => ({ id: 1, name: 'evt', x: 0, y: 0, w: W, h: H, content: ' ', capture: true })
const header = (content: string): TextBox => ({ id: 2, name: 'hdr', x: 0, y: 0, w: W, h: 34, content })
const body = (content: string): TextBox => ({ id: 6, name: 'body', x: 0, y: 40, w: W, h: H - 40, content })

export interface Song {
  title: string
  artist: string
  positionMs: number
  durationMs: number
  playing: boolean
}

export function headerText(song: Song): string {
  const title = song.title || 'Nothing playing'
  return clipPx(song.artist ? `${title} - ${song.artist}` : title, W - 16)
}

export function messagePage(song: Song | null, lines: string[], menu: MenuItem[] = []): Page {
  return {
    layout: 'message',
    texts: [evt(), header(song ? headerText(song) : 'ChordGlass'), body(lines.join('\n'))],
    images: [],
    menu,
  }
}

function statusLine(song: Song, info: SongInfo, flash: string): string {
  if (flash) return flash
  const bits = [keyLine(info), setupLine(info), `${mmss(song.positionMs)}/${mmss(song.durationMs)}`]
  if (!song.playing) bits.push('paused')
  return clipPx(bits.filter(Boolean).join(' · '), W - 16)
}

const timedMenu = (bigChord: boolean): MenuItem[] => [
  { id: MENU.record, label: 'Record chord timings' },
  { id: MENU.transposeUp, label: 'Transpose up' },
  { id: MENU.transposeDown, label: 'Transpose down' },
  { id: MENU.resetSync, label: 'Reset sync' },
  { id: MENU.info, label: 'Song info' },
  { id: MENU.bigChord, label: bigChord ? 'Big chord: off' : 'Big chord: on' },
  { id: MENU.reload, label: 'Reload chords' },
]

export interface TimedState {
  song: Song
  info: SongInfo
  leadMs: number
  /** Position used to pick the chord: Spotify position + lead. */
  displayMs: number
  bigChord: boolean
  flash: string
}

/** The main screen when the chart has times. */
export function timedPage(s: TimedState): Page {
  const tl = s.info.timeline
  const i = eventAt(tl, s.displayMs)
  const cur = i >= 0 ? tl[i] : null
  const next = tl[i + 1] ?? null
  const show = s.info.display
  const status = statusLine(s.song, s.info, s.flash)

  // Countdown to the next change: whole seconds plus a bar, coarse on purpose
  // so the text (and the BLE link) changes a few times per chord, not every tick.
  const segStart = cur ? cur.start : 0
  const segEnd = next ? next.start : cur?.end ?? 0
  const remaining = Math.max(0, segEnd - s.displayMs)
  const progress = segEnd > segStart ? (s.displayMs - segStart) / (segEnd - segStart) : 0
  const countdown = next ? `${bar(progress, 8)} ${Math.ceil(remaining / 1000)}s` : ''

  const then = tl.slice(i + 2, i + 6).map(e => show(e.chord))
  const sectionName = cur?.section || next?.section || ''
  // Say when the next chord starts a new section, so "C, next C" isn't a puzzle.
  const nextLabel = next
    ? show(next.chord) + (cur && next.section && next.section !== cur.section ? `  [${next.section}]` : '')
    : ''

  // The whole current section, current chord in brackets, scrolled so it stays in view.
  const sectionLine = (() => {
    if (!cur) return next ? `Starts with ${show(next.chord)}` : ''
    let a = i
    while (a > 0 && tl[a - 1].section === cur.section) a--
    let b = i
    while (b + 1 < tl.length && tl[b + 1].section === cur.section) b++
    const items = tl.slice(a, b + 1).map((e, k) => (a + k === i ? `[${show(e.chord)}]` : show(e.chord)))
    const at = i - a
    for (let from = Math.max(0, at - 3); from <= at; from++) {
      const line = fitItems(items.slice(from), W - 16)
      if (line.includes('[')) return (from > 0 ? '.. ' : '') + line
    }
    return items[at]
  })()

  if (s.bigChord) {
    const chordSymbol = cur ? show(cur.chord) : next ? show(next.chord) : ''
    const image: ImageBox = {
      id: 3, name: 'chord', x: 0, y: 38, w: CHORD_IMG_W, h: CHORD_IMG_H,
      key: `${chordSymbol}|${cur ? '' : 'dim'}`,
      render: () => renderChordPng(chordSymbol, '', !cur),
    }
    const side = [
      next ? clipPx(`next  ${nextLabel}`, 270) : 'end',
      countdown,
      then.length ? `then  ${fitItems(then, 210)}` : '',
      clipPx(sectionName ? `[${sectionName}]` : '', 270),
    ].join('\n')
    return {
      layout: 'timed-big',
      texts: [
        evt(),
        header(headerText(s.song)),
        { id: 4, name: 'side', x: 300, y: 38, w: W - 300, h: CHORD_IMG_H, content: side },
        { id: 5, name: 'foot', x: 0, y: 190, w: W, h: H - 190, content: `${sectionLine}\n${status}` },
      ],
      images: [image],
      menu: timedMenu(true),
    }
  }

  const nowLine = cur ? `NOW  ${show(cur.chord)}` : 'NOW  -'
  const pad = Math.max(1, Math.round((260 - approxPx(nowLine)) / 5.3))
  const lines = [
    nowLine + ' '.repeat(pad) + (next ? `next ${nextLabel}` : 'end'),
    countdown,
    then.length ? `then  ${fitItems(then, W - 80)}` : '',
    sectionName ? clipPx(`[${sectionName}]  ${sectionLine}`, W - 16) : sectionLine,
    status,
  ]
  return {
    layout: 'timed-text',
    texts: [evt(), header(headerText(s.song)), body(lines.join('\n'))],
    images: [],
    menu: timedMenu(false),
  }
}

export interface UntimedState {
  song: Song
  info: SongInfo
  chart: Chart
  sectionIndex: number
  flash: string
}

/** The main screen when the chart has chords but no times: you step through sections. */
export function untimedPage(s: UntimedState): Page {
  const secs = sections(s.chart)
  const idx = Math.max(0, Math.min(secs.length - 1, s.sectionIndex))
  const sec = secs[idx]
  const nextSec = secs[idx + 1]
  const show = s.info.display
  const chordLines = (chords: string[]) => {
    // Up to two lines of chords.
    const first = fitItems(chords.map(show), W - 16)
    const used = first.split(/\s+/).filter(Boolean).length
    const second = used < chords.length ? fitItems(chords.slice(used).map(show), W - 40) : ''
    const more = used + (second ? second.split(/\s+/).filter(Boolean).length : 0) < chords.length ? ' ...' : ''
    return [first, second ? second + more : ''].filter(Boolean)
  }
  const lines = [
    `[${sec?.name || 'Song'}]  ${idx + 1}/${secs.length}`,
    ...(sec ? chordLines(sec.chords) : []),
    nextSec ? clipPx(`next [${nextSec.name}]  ${nextSec.chords.map(show).join(' ')}`, W - 16) : 'end of song',
    s.flash || clipPx([keyLine(s.info), setupLine(s.info), 'no timing yet'].filter(Boolean).join(' · '), W - 16),
    'swipe: sections · hold: menu',
  ]
  return {
    layout: 'untimed',
    texts: [evt(), header(headerText(s.song)), body(lines.join('\n'))],
    images: [],
    menu: [
      { id: MENU.record, label: 'Record chord timings' },
      { id: MENU.transposeUp, label: 'Transpose up' },
      { id: MENU.transposeDown, label: 'Transpose down' },
      { id: MENU.info, label: 'Song info' },
      { id: MENU.reload, label: 'Reload chords' },
    ],
  }
}

export interface InfoState {
  song: Song
  info: SongInfo | null
  chart: Chart | null
  leadMs: number
  syncErrorMs: number
  rttMs: number
}

export function infoPage(s: InfoState): Page {
  const lines: string[] = []
  const info = s.info
  if (info?.writtenKey) {
    const how = info.keySource === 'chart' ? 'from chart' : `guessed from chords, ${Math.round(info.keyConfidence * 100)}% sure`
    lines.push(clipPx(`${keyLine(info)} (relative ${info.relative}) - ${how}`, W - 16))
  } else lines.push('Key: unknown')
  if (info) {
    lines.push(clipPx(`Tuning: ${info.tuning.name} (${tuningNotes(info.tuning)})${info.tuningGiven ? '' : ' - assumed'}`, W - 16))
    if (info.tuning.uniformOffset !== 0) lines.push(clipPx(tuningAdvice(info.tuning), W - 16))
    lines.push(info.capo ? `Capo: fret ${info.capo}` : 'Capo: none')
  }
  if (s.chart) {
    const timed = s.chart.events.some(e => e.t !== null)
    const src = s.chart.source === 'user' ? 'your chart' : s.chart.source === 'demo' ? 'demo' : 'Chordonomicon'
    lines.push(`Chords: ${src}, ${s.chart.events.length} changes, ${timed ? 'timed' : 'untimed'}`)
  }
  lines.push(`Sync: chords ${s.leadMs} ms early · Spotify off by ${Math.round(s.syncErrorMs)} ms (${Math.round(s.rttMs)} ms trip)`)
  lines.push('tap: back')
  return {
    layout: 'info',
    texts: [evt(), header(headerText(s.song)), body(lines.join('\n'))],
    images: [],
    menu: [],
  }
}

export interface RecordState {
  song: Song
  info: SongInfo
  chart: Chart
  /** Index of the chord the next tap will time. */
  next: number
  timedCount: number
  bigChord: boolean
  flash: string
}

/** Recording: tap the ring/temple as each chord starts. */
export function recordPage(s: RecordState): Page {
  const ev = s.chart.events
  const show = s.info.display
  const target = ev[s.next]
  const then = ev.slice(s.next + 1, s.next + 5).map(e => show(e.chord))
  const progress = `REC ${Math.min(s.next + 1, ev.length)}/${ev.length}`
  const help = s.flash || 'tap as it starts · up: undo · down: skip'
  const footer = `${mmss(s.song.positionMs)}/${mmss(s.song.durationMs)}${s.song.playing ? '' : ' · paused'} · double-tap: save`
  const menu: MenuItem[] = [
    { id: MENU.saveRecording, label: 'Save timings' },
    { id: MENU.restartRecording, label: 'Start recording over' },
    { id: MENU.discardRecording, label: 'Discard recording' },
  ]
  if (s.bigChord && target) {
    return {
      layout: 'record-big',
      texts: [
        evt(),
        header(headerText(s.song)),
        { id: 4, name: 'side', x: 300, y: 38, w: W - 300, h: CHORD_IMG_H, content: [progress, target.section ? clipPx(`[${target.section}]`, 270) : '', then.length ? `then ${fitItems(then, 220)}` : ''].join('\n') },
        { id: 5, name: 'foot', x: 0, y: 190, w: W, h: H - 190, content: `${clipPx(help, W - 16)}\n${footer}` },
      ],
      images: [{
        id: 3, name: 'chord', x: 0, y: 38, w: CHORD_IMG_W, h: CHORD_IMG_H,
        key: `rec|${show(target.chord)}`,
        render: () => renderChordPng(show(target.chord)),
      }],
      menu,
    }
  }
  const lines = [
    target ? `${progress}   next to tap: ${show(target.chord)}` : `${progress}   all chords timed`,
    target?.section ? `[${target.section}]` : '',
    then.length ? `then ${fitItems(then, W - 80)}` : '',
    clipPx(help, W - 16),
    footer,
  ]
  return { layout: 'record-text', texts: [evt(), header(headerText(s.song)), body(lines.join('\n'))], images: [], menu }
}
