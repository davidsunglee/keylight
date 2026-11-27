// renderMarkdown as the viewer calls it: a document's source, its path, and
// the artifact root that links and embeds must stay inside.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EMBED_SANDBOX, renderMarkdown } from "../render";

const base = realpathSync(mkdtempSync(join(tmpdir(), "keylight-render-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const root = join(base, "artifacts");
const task = join(root, "repo", "task");
const doc = join(task, "doc.md");
const outside = join(base, "outside");
mkdirSync(task, { recursive: true });
mkdirSync(outside);
for (const name of ["other.md", "page.html", "pic.png", "notes.txt", "my file.md"]) writeFileSync(join(task, name), "");
writeFileSync(join(outside, "secret.md"), "");

const render = (source: string) => renderMarkdown(source, doc, root);
const html = (source: string) => render(source).html;

describe("renderMarkdown", () => {
  test("titles a document by its first h1, or by its file name without one", () => {
    expect(render("intro\n\n# Main\n\n# Second").title).toBe("Main");
    expect(render("## Only a section").title).toBe("doc.md");
  });

  test("gives every heading a unique id from its text, and lists it in the outline", () => {
    const rendered = render("# Title\n\n## Café & Bar\n\n### Sub `code`\n\n## Café & Bar\n\n## !!!\n");
    expect(rendered.outline).toEqual([
      { level: 1, text: "Title", id: "title", foldable: false },
      { level: 2, text: "Café & Bar", id: "café-bar", foldable: true },
      { level: 3, text: "Sub code", id: "sub-code", foldable: false },
      { level: 2, text: "Café & Bar", id: "café-bar-1", foldable: true },
      { level: 2, text: "!!!", id: "section", foldable: true },
    ]);
    expect(rendered.html).toContain('<h3 id="sub-code">Sub <code>code</code></h3>');
  });

  test("folds each section at the highest level below the title, up to the next heading at that level", () => {
    expect(html("# Title\n\nlead\n\n### One\n\ntext\n\n#### Deeper\n\n### Two\n")).toBe(
      '<h1 id="title">Title</h1>\n<p>lead</p>\n' +
        '<details class="section" open="">\n<summary>\n<h3 id="one">One</h3>\n</summary>\n<p>text</p>\n' +
        '<h4 id="deeper">Deeper</h4>\n</details>\n' +
        '<details class="section" open="">\n<summary>\n<h3 id="two">Two</h3>\n</summary>\n</details>\n',
    );
    expect(html("# Only a title\n\ntext")).toBe('<h1 id="only-a-title">Only a title</h1>\n<p>text</p>\n');
  });

  test("shows YAML frontmatter as a folded table, with chips for the summary keys", () => {
    expect(html("---\ntype: tdd\ntags: [a, b]\nmeta: {x: 1}\nempty: null\n---\nBody")).toBe(
      '<details class="frontmatter"><summary><span class="chip">tdd</span></summary><table>' +
        "<tr><th>type</th><td>tdd</td></tr><tr><th>tags</th><td>a, b</td></tr>" +
        "<tr><th>meta</th><td>{&quot;x&quot;:1}</td></tr><tr><th>empty</th><td>null</td></tr></table></details>\n" +
        "<p>Body</p>\n",
    );
    expect(html("---\nauthor: me\n---\n")).toBe(
      '<details class="frontmatter"><summary>Frontmatter</summary><table><tr><th>author</th><td>me</td></tr></table></details>\n',
    );
  });

  test("renders frontmatter that is not a YAML mapping as ordinary content", () => {
    expect(html("---\n- a\n---\nBody")).toBe("<hr>\n<ul>\n<li>a</li>\n</ul>\n<hr>\n<p>Body</p>\n");
    expect(html("---\n: : bad\n  - x\n---\nBody")).toBe(
      "<hr>\n<p>: : bad</p>\n<ul>\n<li>x</li>\n</ul>\n<hr>\n<p>Body</p>\n",
    );
  });

  test("leaves a code fence inside frontmatter out of the rendered body", () => {
    expect(html("---\nnote: |\n  ```mermaid\n  graph TD\n  ```\n---\nBody")).not.toContain("mermaid-block");
  });

  test("turns list items that start with a checkbox into task items", () => {
    expect(html("- [ ] open\n- [x] done\n- plain\n- [y] not a box\n\n1. [X] numbered")).toBe(
      '<ul>\n<li class="task"><input type="checkbox" disabled> open</li>\n' +
        '<li class="task done"><input type="checkbox" disabled checked> done</li>\n' +
        "<li>plain</li>\n<li>[y] not a box</li>\n</ul>\n" +
        '<ol>\n<li class="task done"><input type="checkbox" disabled checked> numbered</li>\n</ol>\n',
    );
    expect(html("[ ] not in a list")).toBe("<p>[ ] not in a list</p>\n");
    expect(html("- **[ ] bold first**")).toBe("<ul>\n<li><strong>[ ] bold first</strong></li>\n</ul>\n");
  });

  test("passes the allowed formatting tags and shows any other tag as text", () => {
    expect(html("Stream<T> and <task-slug> <b>bold</b> <kbd>K</kbd> <custom-el>x</custom-el>")).toBe(
      "<p>Stream&lt;T&gt; and &lt;task-slug&gt; <b>bold</b> <kbd>K</kbd> &lt;custom-el&gt;x&lt;/custom-el&gt;</p>\n",
    );
    expect(html('<input type="checkbox" checked> <script>alert(1)</script>')).toBe(
      "<p>&lt;input type=&quot;checkbox&quot; checked&gt; &lt;script&gt;alert(1)&lt;/script&gt;</p>\n",
    );
  });

  test("strips inline handlers, javascript: URLs and comments from allowed tags", () => {
    expect(html('<b onclick="x()">bold</b> <a href="javascript:alert(1)">a</a> <!-- note -->tail')).toBe(
      '<p><b>bold</b> <a href="alert(1)">a</a> tail</p>\n',
    );
    expect(html("<div onmouseover='y' data-x=1>\nblock\n</div>\n<!-- template note -->\n")).toBe(
      "<div data-x=1>\nblock\n</div>\n\n",
    );
  });

  test("highlights fenced code by language, with aliases, and escapes what it cannot highlight", () => {
    expect(html("```ts\nconst a = 1;\n```")).toBe(
      '<pre class="code" data-lang="ts"><code><span class="hljs-keyword">const</span> a = ' +
        '<span class="hljs-number">1</span>;\n</code></pre>\n',
    );
    expect(html("```zsh\necho hi\n```")).toBe(
      '<pre class="code" data-lang="zsh"><code><span class="hljs-built_in">echo</span> hi\n</code></pre>\n',
    );
    expect(html("```text\nplain <x>\n```")).toBe('<pre class="code"><code>plain &lt;x&gt;\n</code></pre>\n');
    expect(html("```nosuchlang\nraw <x>\n```")).toBe(
      '<pre class="code" data-lang="nosuchlang"><code>raw &lt;x&gt;\n</code></pre>\n',
    );
    expect(html("    indented <code>\n")).toBe('<pre class="code"><code>indented &lt;code&gt;\n</code></pre>\n');
  });

  test("marks each line of a diff by its kind", () => {
    expect(html("```diff\n@@ -1 +1 @@\n-old\n+new\n~mod\n ctx\n\n```")).toBe(
      '<pre class="code diff" data-lang="diff"><code><span class="line hunk">@@ -1 +1 @@</span>' +
        '<span class="line del">-old</span><span class="line add">+new</span><span class="line mod">~mod</span>' +
        '<span class="line ctx"> ctx</span><span class="line ctx"> </span></code></pre>\n',
    );
    expect(html("```patch\n+x\n```")).toContain('<pre class="code diff" data-lang="patch">');
  });

  test("leaves Mermaid source for the browser to draw", () => {
    expect(html("```mermaid\ngraph TD; A-->B\n```")).toBe(
      '<div class="mermaid-block"><pre class="mermaid-src">graph TD; A--&gt;B\n</pre></div>\n',
    );
  });

  test("wraps tables so a wide one scrolls inside its own box", () => {
    expect(html("| a |\n|---|\n| 1 |")).toStartWith('<div class="table-wrap"><table>\n');
    expect(html("| a |\n|---|\n| 1 |")).toEndWith("</table></div>\n");
  });

  test("embeds an artifact in a sandboxed frame without same-origin access, and an image as a figure", () => {
    expect(html("```task-artifact\npage.html\n\npic.png\n```")).toBe(
      '<figure class="embed"><iframe class="embed-frame" src="/raw/repo/task/page.html" title="page.html" ' +
        `loading="lazy" sandbox="${EMBED_SANDBOX}"></iframe>` +
        '<figcaption><a href="/raw/repo/task/page.html" target="_blank" rel="noopener">page.html &nearr;</a>' +
        "</figcaption></figure>\n" +
        '<figure class="embed"><img src="/raw/repo/task/pic.png" alt="pic.png"><figcaption>pic.png</figcaption></figure>\n',
    );
    expect(EMBED_SANDBOX).not.toContain("allow-same-origin");
  });

  test("finds an embedded artifact by absolute path or beside the document, and never outside the root", () => {
    const embed = html(
      ["```task-artifact", join(task, "page.html"), ".humanlayer/tasks/x/page.html", "../../../outside/secret.md"]
        .concat(["missing.html", "```"])
        .join("\n"),
    );
    expect(embed.match(/src="\/raw\/repo\/task\/page\.html"/g)).toHaveLength(2);
    expect(embed).toContain(
      '<p class="embed-missing">Artifact not found: <code>../../../outside/secret.md</code></p>\n',
    );
    expect(embed).toContain('<p class="embed-missing">Artifact not found: <code>missing.html</code></p>\n');
  });

  test("points local links at the viewer, documents to /view/ and other files to /raw/", () => {
    expect(html("[o](other.md#part) [p](page.html) [n](notes.txt) [s](my%20file.md)")).toBe(
      '<p><a href="/view/repo/task/other.md#part">o</a> <a href="/raw/repo/task/page.html">p</a> ' +
        '<a href="/raw/repo/task/notes.txt">n</a> <a href="/view/repo/task/my%20file.md">s</a></p>\n',
    );
    expect(html(`[abs](${pathToFileURL(join(task, "other.md")).pathname})`)).toBe(
      '<p><a href="/view/repo/task/other.md">abs</a></p>\n',
    );
  });

  test("leaves a link alone when its target is missing, outside the root, or not percent-encoded validly", () => {
    expect(html("[m](missing.md) [s](../../../outside/secret.md) [b](%E0%A4)")).toBe(
      '<p><a href="missing.md">m</a> <a href="../../../outside/secret.md">s</a> <a href="%E0%A4">b</a></p>\n',
    );
  });

  test("opens external links in a new tab and keeps in-page anchors", () => {
    expect(html("[ext](https://x.example) [anchor](#sec) [mail](mailto:a@b)")).toBe(
      '<p><a href="https://x.example" target="_blank" rel="noopener">ext</a> <a href="#sec">anchor</a> ' +
        '<a href="mailto:a@b" target="_blank" rel="noopener">mail</a></p>\n',
    );
  });

  test("serves local images through /raw/ and leaves remote or missing ones alone", () => {
    expect(html("![p](pic.png) ![r](https://x.example/i.png) ![m](nope.png)")).toBe(
      '<p><img src="/raw/repo/task/pic.png" alt="p"> <img src="https://x.example/i.png" alt="r"> ' +
        '<img src="nope.png" alt="m"></p>\n',
    );
  });
});
