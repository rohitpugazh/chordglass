// Puts pages on the glasses with as few bridge calls as possible.
//
// Measured costs (even-g2-notes/docs/performance.md): rebuildPageContainer
// ~165 ms, textContainerUpgrade ~83 ms each, updateImageRawData ~104 ms + a
// little per KB. So: rebuild only when the layout or menu changes, otherwise
// update just the boxes whose content changed. Renders are coalesced: while
// one is going out, newer requests replace each other and only the latest is sent.

import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  isMenuNameWithinLimit,
  isValidMenuItemID,
} from '@evenrealities/even_hub_sdk'
import { hasBridge, serial } from '../bridge'
import { glassesText } from './text'

export interface TextBox {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  content: string
  /** Exactly one box per page receives gestures. Keep its text short so it never scrolls. */
  capture?: boolean
  border?: number
}

export interface ImageBox {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  /** Changes whenever the picture should change; render() is only called then. */
  key: string
  render: () => string
}

export interface MenuItem {
  id: number
  label: string
}

export interface Page {
  /** Pages with the same layout key have the same boxes, so they can be updated in place. */
  layout: string
  texts: TextBox[]
  images: ImageBox[]
  menu: MenuItem[]
}

export interface PreviewSink {
  show(page: Page, imageData: Map<string, string>): void
}

const debug = import.meta.env.DEV ? (...a: unknown[]) => console.debug('[screen]', ...a) : () => {}

export class Screen {
  private shownLayout: string | null = null
  private shownMenu = ''
  private shownText = new Map<string, string>()
  private shownImage = new Map<string, string>()
  private imageCache = new Map<string, string>()
  private startupSpent = false
  private wanted: Page | null = null
  private running: Promise<void> | null = null
  private imageFailures = 0
  /** Set when image sends keep failing (e.g. after the exit dialog wedges the image channel). */
  imagesBroken = false
  preview: PreviewSink | null = null

  /** Forget what's on the glasses, e.g. after the app returns to the foreground. */
  invalidate() {
    this.shownLayout = null
  }

  show(page: Page): Promise<void> {
    this.wanted = page
    this.running ??= this.loop().finally(() => { this.running = null })
    return this.running
  }

  private async loop() {
    while (this.wanted) {
      const page = this.wanted
      this.wanted = null
      try {
        await this.push(page)
      } catch (e) {
        debug('render failed', e)
        this.shownLayout = null
      }
    }
  }

  private imageFor(box: ImageBox): string {
    const cacheKey = `${box.w}x${box.h}|${box.key}`
    let data = this.imageCache.get(cacheKey)
    if (!data) {
      data = box.render()
      if (this.imageCache.size > 64) this.imageCache.clear()
      this.imageCache.set(cacheKey, data)
    }
    return data
  }

  private async push(page: Page) {
    const texts = page.texts.map(t => ({ ...t, content: glassesText(t.content) || ' ' }))
    const images = new Map(page.images.map(b => [b.name, this.imageFor(b)]))
    this.preview?.show({ ...page, texts }, images)
    if (!hasBridge()) return

    const menuKey = JSON.stringify(page.menu)
    if (page.layout !== this.shownLayout || menuKey !== this.shownMenu) {
      await this.rebuild(page, texts)
      this.shownLayout = page.layout
      this.shownMenu = menuKey
      this.shownText = new Map(texts.map(t => [t.name, t.content]))
      this.shownImage.clear()
    } else {
      for (const t of texts) {
        if (this.shownText.get(t.name) === t.content) continue
        const ok = await serial(b => b.textContainerUpgrade(new TextContainerUpgrade({
          containerID: t.id, containerName: t.name, content: t.content.slice(0, 1990),
        })))
        if (ok) this.shownText.set(t.name, t.content)
        // A newer frame is waiting: stop here and send that instead.
        if (this.wanted) return
      }
    }

    for (const box of page.images) {
      const data = images.get(box.name)!
      if (this.shownImage.get(box.name) === box.key) continue
      const result = ImageRawDataUpdateResult.normalize(
        await serial(b => b.updateImageRawData(new ImageRawDataUpdate({ containerID: box.id, containerName: box.name, imageData: data }))),
      )
      if (ImageRawDataUpdateResult.isSuccess(result)) {
        this.shownImage.set(box.name, box.key)
        this.imageFailures = 0
      } else {
        debug('image send failed', result)
        if (++this.imageFailures >= 2) this.imagesBroken = true
      }
      if (this.wanted) return
    }
  }

  private async rebuild(page: Page, texts: TextBox[]) {
    const textObject = texts.map(t => new TextContainerProperty({
      xPosition: t.x, yPosition: t.y, width: t.w, height: t.h,
      containerID: t.id, containerName: t.name,
      content: t.content.slice(0, 990),
      isEventCapture: t.capture ? 1 : 0,
      borderWidth: t.border ?? 0, borderColor: 5, paddingLength: 0,
    }))
    const imageObject = page.images.map(b => new ImageContainerProperty({
      xPosition: b.x, yPosition: b.y, width: b.w, height: b.h, containerID: b.id, containerName: b.name,
    }))
    const items = page.menu.filter(m => isValidMenuItemID(m.id) && isMenuNameWithinLimit(m.label))
    const menuObject = items.length
      ? new MenuContainerProperty({ menuItems: items.map(m => new MenuItemProperty({ itemID: m.id, itemName: m.label })) })
      : undefined
    const containerTotalNum = textObject.length + imageObject.length
    const parts = { containerTotalNum, textObject, imageObject: imageObject.length ? imageObject : undefined, menuObject }

    if (!this.startupSpent) {
      // One shot per session: latch it whether or not it works, and fall back to
      // rebuild. Retrying a failed startup blocks ~2 s each time.
      this.startupSpent = true
      const result = await serial(b => b.createStartUpPageContainer(new CreateStartUpPageContainer(parts)), 8000)
      if (StartUpPageCreateResult.normalize(result) === StartUpPageCreateResult.success) return
      debug('startup page rejected', result)
    }
    const ok = await serial(b => b.rebuildPageContainer(new RebuildPageContainer(parts)))
    if (!ok) throw new Error('Page rebuild rejected')
  }
}
