---
name: figma-templates
description: Find a ready Figma Community template to start a design from, and read it. Use when the user wants to build or design something visual (an app or web UI, a dashboard, a landing page, a poster, slides, a logo or icon set) and a template could save work, or when they ask for Figma templates.
---

# Figma templates

The user wants Figma only for its Community templates, and doesn't want to browse them himself. When a design or build starts, Harv looks for templates, shows the best few, and works from the one picked.

## 1. Search in your shared browser (free)

The Figma connector is nearly useless for browsing: his free account gets about **20 Figma tool calls a month**, and it can only read files in his own drafts. So search with your browser tools, which cost nothing:

- Open `https://www.figma.com/community/search?resource_type=files&sort_by=relevancy&query=<words>` (English words work best: "fitness app ui kit", "saas dashboard", "portfolio website").
- Look at the results (snapshot); open the 3–5 that fit best and check the preview, how complete it is (screens, components, auto layout), the likes/duplicates count and the licence on the file page.
- Skip paid files and files that are only a cover image.

## 2. Show three, he picks

One short list: name, one line on why it fits, the link. Picking a look is his taste call, so this is the one question to ask. If he said "just pick one", pick and say which.

## 3. Bring the pick into his drafts

On the file's page, "Open in Figma" duplicates it into his drafts. This needs his Figma login in your browser; if it isn't there, say so in one line and continue with what the page shows.

## 4. Read it with the connector, sparingly

Each call counts against the ~20 a month. For the duplicated file (its key is in the URL `figma.com/design/<fileKey>/…`):

1. `get_metadata` once for the page and frame names.
2. `get_screenshot` or `get_design_context` only on the frames you will really use (one or two).

Never loop over every frame. If a call says the monthly limit is reached, say so and work from the browser previews.

## 5. Build from it

Use the template as the starting point: its layout, spacing, type scale and components, in the user's project's own stack and look. Credit the author where the licence asks (most Community files are CC BY 4.0).
