---
name: JobPilot
description: A calm local control surface for bounded job-search automation.
colors:
  dispatch-indigo: "oklch(0.46 0.12 294)"
  dispatch-indigo-hover: "oklch(0.40 0.13 294)"
  dispatch-indigo-soft: "oklch(0.94 0.028 294)"
  paper-white: "oklch(1 0 0)"
  quiet-surface: "oklch(0.975 0.006 294)"
  strong-surface: "oklch(0.945 0.012 294)"
  desk-ink: "oklch(0.22 0.02 294)"
  muted-ink: "oklch(0.47 0.018 294)"
  structural-line: "oklch(0.89 0.012 294)"
  confirmed-green: "oklch(0.48 0.12 155)"
  caution-amber: "oklch(0.56 0.13 72)"
  stop-red: "oklch(0.50 0.17 28)"
typography:
  headline:
    fontFamily: "Inter, Segoe UI Variable, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Inter, Segoe UI Variable, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Inter, Segoe UI Variable, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Inter, Segoe UI Variable, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.5
rounded:
  sm: "8px"
  md: "12px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.dispatch-indigo}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.dispatch-indigo-hover}"
  button-quiet:
    backgroundColor: "{colors.strong-surface}"
    textColor: "{colors.desk-ink}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "38px"
  input:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.desk-ink}"
    rounded: "{rounded.sm}"
    padding: "9px 10px"
    height: "40px"
  status-chip:
    backgroundColor: "{colors.dispatch-indigo-soft}"
    textColor: "{colors.dispatch-indigo}"
    rounded: "{rounded.pill}"
    padding: "0 9px"
    height: "24px"
---

# Design System: JobPilot

## Overview

**Creative North Star: "The Quiet Dispatch Desk"**

JobPilot feels like a carefully arranged desk for supervising consequential work: calm, legible, and continuously ready. Linear informs hierarchy and density, Raycast informs immediate feedback, and Stripe Dashboard informs precise operational language. A fixed sidebar and sticky operation bar keep location, batch state, and stop controls available while the main canvas stays spacious and direct.

The interface is a product surface, not a performance. Automation state, risk, limits, and human control take precedence over decoration. It explicitly rejects traditional enterprise admin dashboards, neon cyberpunk control rooms, AI gradients, glass effects, oversized vanity metrics, stacked card grids, and decorative “agent thinking” theatrics.

**Key Characteristics:**

- Restrained information density with strong alignment
- Consequential actions separated from routine controls
- State conveyed through text, shape, and color together
- Responsive feedback without choreographed entrances

## Colors

Pure paper white and violet-tinted neutrals form a quiet desk; one deep dispatch indigo marks selection, primary action, and active automation. Green confirms, amber asks for attention, and red stops.

### Primary

- **Dispatch Indigo:** Selected navigation, primary actions, active state, and focus relationships only.
- **Quiet Dispatch Wash:** Selected rows and field focus without turning whole panels purple.

### Neutral

- **Paper White:** Main canvas and control face.
- **Quiet / Strong Surface:** Sidebar, editor containers, quiet buttons, and hover feedback.
- **Desk / Muted Ink:** Primary and subordinate text.
- **Structural Line:** One-pixel dividers that organize content without card stacking.

### Tertiary

- **Confirmed Green:** Successful communication and readiness.
- **Caution Amber:** Risk, manual takeover, and unresolved preparation.
- **Stop Red:** Failure, emergency stop, and irreversible-action warnings.

### Named Rules

**The One Signal Rule.** Saturated dispatch indigo is limited to the current selection, the primary action, and active system state. It is never background decoration.

**The Three Consequences Rule.** Green confirms, amber requests attention, and red stops. Every use also carries a word, icon, or shape so color is never the only signal.

## Typography

**Display Font:** Inter with Segoe UI Variable, Microsoft YaHei UI, and system sans fallbacks  
**Body Font:** Inter with Segoe UI Variable, Microsoft YaHei UI, and system sans fallbacks

**Character:** One humanist sans stack keeps Chinese and Latin operational text consistent. Compact labels and restrained headings create hierarchy without marketing-scale type.

### Hierarchy

- **Headline** (700, 28px, 1.18): page identity only; never a vanity metric.
- **Title** (700, 18px, 1.3): sections and editor panels.
- **Body** (400, 14px, 1.65): explanations and consequential copy, capped near 70 characters per line.
- **Label** (650, 12px, 1.5): fields, state labels, controls, and metadata.

### Named Rules

**The Operational Voice Rule.** Headings identify tasks and state; they never become oversized marketing statements. Labels use sentence case and remain readable at 200% zoom.

## Elevation

The system is flat by default. Tonal changes and one-pixel dividers establish hierarchy; resting content does not float. Only the confirmation dialog rises above the page. The sticky operation bar uses translucent paper white and restrained blur to preserve context while scrolling.

### Shadow Vocabulary

- **Dialog lift** (`0 6px 8px oklch(0.12 0.02 294 / 0.20)`): modal confirmation only.
- **Field focus** (`0 0 0 3px oklch(0.94 0.028 294)`): reinforces the dispatch-indigo focus border.

### Named Rules

**The State Earns Depth Rule.** Resting content does not float. Elevation appears only when interaction or stacking requires it.

## Components

Components are compact, direct, and candid about consequence. Interactive controls expose hover, focus-visible, active, disabled, loading, and error states where applicable.

### Buttons

- **Shape:** gently curved operational rectangle (8px radius), at least 38px high.
- **Primary:** dispatch indigo with paper-white text and 14px horizontal padding; reserved for one clear next action.
- **Quiet:** strong-surface fill for routine actions; emergency stop uses stop-red soft surface and text.
- **Hover / Focus:** 180ms color response, 120ms one-pixel active shift, and a three-pixel visible focus outline.

### Chips

- **Style:** compact 24px pills with soft tonal backgrounds and semantic text.
- **State:** every chip includes a readable state word; dots and color only reinforce it.

### Cards / Containers

- **Corner Style:** 12px for meaningful grouped surfaces such as the dispatch panel, editors, and dialog.
- **Background:** paper white for content, quiet surface for editors, desk ink for the batch dispatch panel.
- **Shadow Strategy:** no shadow at rest; borders and tonal contrast do the work.
- **Internal Padding:** 22–28px; list and table rows use dividers instead of individual cards.

### Inputs / Fields

- **Style:** paper-white face, one-pixel structural border, 8px radius, 40px height.
- **Focus:** dispatch-indigo border plus a three-pixel quiet dispatch wash.
- **Error / Disabled:** direct error copy; disabled controls remain legible and visibly unavailable.

### Navigation

The 244px quiet-surface sidebar uses muted default labels, a stronger neutral hover, and a quiet dispatch wash for the active destination. Below 960px it becomes a 72px icon rail; content collapses to one column below 680px without horizontal page overflow.

### Dispatch Panel

The dark desk-ink batch panel is the sole high-contrast surface. It states the next batch limit, selected plans, and one primary start action. It must never become a generic metrics hero.

## Do's and Don'ts

### Do:

- **Do** keep current batch state and stop controls continuously visible in the 64px sticky operation bar.
- **Do** explain risky actions in direct Chinese before the user confirms them.
- **Do** use dispatch indigo on no more than ten percent of a screen.
- **Do** preserve keyboard operation, visible focus, non-color state cues, 200% zoom, and reduced motion.
- **Do** use restrained 120–180ms state transitions only for meaningful feedback.

### Don't:

- **Don't** resemble a traditional enterprise admin dashboard.
- **Don't** use neon cyberpunk control rooms, AI gradients, glass effects, or decorative “agent thinking” theatrics.
- **Don't** introduce oversized vanity metrics, stacked card grids, or cards nested inside cards.
- **Don't** use purple gradients; dispatch indigo is a sparse flat signal, never ambient decoration.
- **Don't** make risky automation feel playful, frictionless, or reversible when it is not.
