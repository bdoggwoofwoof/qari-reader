/** Thrown when a file has no readable text layer (a scan or photo) and needs text recognition first. */
export class NeedsOcrError extends Error {
  pages: number
  constructor(pages: number) {
    super('This file is scanned page images, so its text needs to be recognized first.')
    this.pages = pages
  }
}
