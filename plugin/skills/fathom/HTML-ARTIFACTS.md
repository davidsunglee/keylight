# HTML artifacts

An **HTML artifact** is one focused, self-contained page in the task folder. Reach for one when a concept is too dense for Mermaid or plain text: a UI mockup, a layout, a side-by-side comparison, data flow with annotations, an interactive explanation.

- **Write it** to the task folder as `<prefix>-<description>.html`. The skill that sent you here names the prefix (`diagram`, `mockup`, `show-me`).
- **Style it** from [`html-artifact-template.html`](html-artifact-template.html), unless the skill that sent you here names another style (a product mockup follows the product's own design system): copy its `<style>` block and build the content in `<body>` with its prose elements and utility classes (`.card`, `.badge*`, `.stat*`, `.ba`). The template follows the device's light or dark appearance, so the page matches the viewer around it.
- **Keep it focused** on the decision at hand, with real labels and data, and usable on a phone.
- **Keep it self-contained.** The viewer runs each page sandboxed: inline scripts and styles work; storage and requests to other task files do not.

To show it inside a Markdown document, embed it with a `task-artifact` fence holding the file name:

````markdown
```task-artifact
diagram-retry-backoff.html
```
````

To show it in conversation, embed it in an entry on the scratch page, as [`SCRATCH.md`](SCRATCH.md) describes.
