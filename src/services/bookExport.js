import { createZip } from "../utils/zipWriter.js";

// The finished book as a file: Word (.docx), e-book (.epub), or a page to
// print or save as PDF from the browser. Only the person's own chapters.
const escapeXml = (value) =>
  String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
const paragraphs = (text) =>
  String(text || "")
    .split(/\n\s*\n|\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
// An untitled part is named by its number: „Глава 3“ in a book, „Част 3“
// in every other specialist's project.
export const chapterHeading = (chapter, unit = "Глава") =>
  chapter.title ? `${chapter.number}. ${chapter.title}` : `${unit} ${chapter.number}`;

export function bookDocx(title, chapters, { unit } = {}) {
  const body = [
    `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(title)}</w:t></w:r></w:p>`,
    ...chapters.flatMap((chapter, index) => [
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/>${index ? '<w:pageBreakBefore/>' : ""}</w:pPr><w:r><w:t xml:space="preserve">${escapeXml(chapterHeading(chapter, unit))}</w:t></w:r></w:p>`,
      ...paragraphs(chapter.text).map(
        (line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`,
      ),
    ]),
  ].join("");
  return createZip([
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      "word/_rels/document.xml.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ],
    [
      "word/styles.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="480"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>',
    ],
    [
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
    ],
  ]);
}

export function bookEpub(title, chapters, { id, language = "bg", modified = new Date().toISOString(), unit } = {}) {
  const stamp = modified.replace(/\.\d+Z$/u, "Z");
  const items = chapters.map((chapter, index) => ({ chapter, file: `chapter-${index + 1}.xhtml`, id: `c${index + 1}` }));
  const page = (heading, inner) =>
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${language}" xml:lang="${language}"><head><meta charset="UTF-8"/><title>${escapeXml(heading)}</title></head><body>${inner}</body></html>`;
  return createZip([
    ["mimetype", "application/epub+zip", { store: true }],
    [
      "META-INF/container.xml",
      '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ],
    [
      "OEBPS/content.opf",
      `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:${escapeXml(id)}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:language>${language}</dc:language><meta property="dcterms:modified">${stamp}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items
        .map(({ file, id: itemId }) => `<item id="${itemId}" href="${file}" media-type="application/xhtml+xml"/>`)
        .join("")}</manifest><spine>${items.map(({ id: itemId }) => `<itemref idref="${itemId}"/>`).join("")}</spine></package>`,
    ],
    [
      "OEBPS/nav.xhtml",
      page(
        title,
        `<nav epub:type="toc"><h1>${escapeXml(title)}</h1><ol>${items
          .map(({ chapter, file }) => `<li><a href="${file}">${escapeXml(chapterHeading(chapter, unit))}</a></li>`)
          .join("")}</ol></nav>`,
      ),
    ],
    ...items.map(({ chapter, file }) => [
      `OEBPS/${file}`,
      page(
        chapterHeading(chapter, unit),
        `<h1>${escapeXml(chapterHeading(chapter, unit))}</h1>${paragraphs(chapter.text)
          .map((line) => `<p>${escapeXml(line)}</p>`)
          .join("")}`,
      ),
    ]),
  ]);
}

// A plain page that opens the browser's print window: "Save as PDF" there.
export function bookPrintPage(title, chapters, { unit } = {}) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${escapeXml(title)}</title><script src="/book-print.js" defer></script><style>body{max-width:40rem;margin:2rem auto;padding:0 1rem;font:18px/1.6 Georgia,"Times New Roman",serif;color:#111;background:#fff}h1{text-align:center;margin:3rem 0}h2{margin-top:3rem;page-break-before:always}h2:first-of-type{page-break-before:auto}p{margin:0 0 .8rem;text-align:justify}@page{margin:2cm}</style></head><body><h1>${escapeXml(title)}</h1>${chapters
    .map(
      (chapter) =>
        `<h2>${escapeXml(chapterHeading(chapter, unit))}</h2>${paragraphs(chapter.text)
          .map((line) => `<p>${escapeXml(line)}</p>`)
          .join("")}`,
    )
    .join("")}</body></html>`;
}
