// Inlines the Vite build (dist/) into ONE self-contained HTML file for the Android WebView.
// Needed because MainActivity loads the page with loadDataWithBaseURL("https://machi.ai/"), so
// "/assets/xyz.js" references would not resolve and the app would open blank.
import fs from "fs";
import path from "path";

const dist = process.argv[2] || "dist";
const out = process.argv[3] || path.join(dist, "index.single.html");
let html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const read = (u) => {
  const rel = u.replace(/^https?:\/\/[^/]+/, "").replace(/^\.?\//, "");
  const f = path.join(dist, rel);
  if (!fs.existsSync(f)) throw new Error("Referenced asset not found: " + f);
  return fs.readFileSync(f, "utf8");
};
const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`)) || [])[1];
let jsCount = 0, cssCount = 0;

// local <script src="...js"> -> inline (keeps type="module")
html = html.replace(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>/g, (tag) => {
  const src = attr(tag, "src");
  if (!src || /^https?:\/\//.test(src) && !src.includes("machi.ai")) return tag; // leave external scripts
  jsCount++;
  const type = attr(tag, "type");
  const code = read(src).replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
  return `<script${type ? ` type="${type}"` : ""}>\n${code}\n</script>`;
});
// local stylesheets -> inline
html = html.replace(/<link\b[^>]*>/g, (tag) => {
  const rel = attr(tag, "rel"), href = attr(tag, "href");
  if (rel === "modulepreload") return ""; // chunks are inlined; preload hints would 404
  if (rel === "stylesheet" && href && /\.css$/.test(href) && !/^https?:\/\/(?!machi\.ai)/.test(href)) {
    cssCount++;
    return `<style>\n${read(href).replace(/<\/style/gi, "<\\/style")}\n</style>`;
  }
  return tag;
});
if (jsCount < 1) throw new Error("No local script was inlined - unexpected dist/index.html format");
if (/(src|href)=["']\/?assets\//.test(html)) throw new Error("Unresolved /assets/ reference remains (code-split chunk?)");
fs.writeFileSync(out, html);
console.log(`inline-html: wrote ${out} (${(html.length / 1024).toFixed(0)} KB, ${jsCount} script, ${cssCount} css)`);
