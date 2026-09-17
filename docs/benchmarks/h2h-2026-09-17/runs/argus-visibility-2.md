# Argus · Visibility · round 2

**Goal met (read from the page): yes** (Hide applied; 7/7 answered not clickable) · claimed success · 5 tool calls · 12.4 s · $0.048

## 1. `browser_open`

```json
{
  "url": "http://127.0.0.1:40695/visibility"
}
```

```
lane main opened
  → http://127.0.0.1:40695/visibility
  title "Visibility"
  + "UITAP"
  + "Home"
  + "Resources"
  + "Visibility"
  + "Checking if element is visible on screen may be a non trivial task."
  + "An element may be removed (simplest case),"
  + "it may have zero height or width,"
  + "it may be covered by another element,"
  + "it may be hidden using styles: opacity: 0, visibility: hidden, display: none,"
  + "or moved offscreen."
  + "Scenario"
  + "Learn locators of all buttons."
  + … 15 more

Visibility (1280x800)
landmarks:
  navigation e0.28
  contentinfo e0.109
headings:
  Visibility e0.43
  Scenario e0.63
  Playground e0.74
actions:
  link:UITAP e0.29
  link:Home e0.36
  link:Resources e0.39
  button:Hide e0.80
  button:Removed e0.83
  button:Zero Width e0.86
  button:Overlapped e0.89
  button:Opacity 0 e0.94
  button:Visibility Hidden e0.97
  button:Display None e0.100
  button:Offscreen e0.103
  link:Star inflectra/ui-test-automation-playground on GitHub e0.118
  link:Fork the website on GitHub e0.127
  link:Rapise e0.132
  link:Inflectra Corporation e0.6
  link:Apache License 2.0 e0.140
```

## 2. `browser_click`

```json
{
  "target": "button:Hide"
}
```

```
✓ click button:Hide e0.80  163ms
  − "Removed"
  − "Opacity 0"
  − "Visibility Hidden"
  − "Display None"
```

## 3. `browser_outline`

```json
{
  "budget": 600
}
```

```
Visibility (1280x800)
landmarks:
  navigation e0.28
  contentinfo e0.109
headings:
  Visibility e0.43
  Scenario e0.63
  Playground e0.74
actions:
  button:Overlapped e0.89 [covered by e0.91 div#hidingLayer]
  link:UITAP e0.29
  link:Home e0.36
  link:Resources e0.39
  button:Hide e0.80
  link:Star inflectra/ui-test-automation-playground on GitHub e0.118
  link:Fork the website on GitHub e0.127
  link:Rapise e0.132
  link:Inflectra Corporation e0.6
  link:Apache License 2.0 e0.140
  button:Offscreen e0.103 [below]
```

## 4. `browser_find`

```json
{
  "target": "e0.103"
}
```

```
button:Offscreen e0.103 @-9999,-9999 95x38
```

## 5. `browser_find`

```json
{
  "target": "e0.86"
}
```

```
button:Zero Width e0.86 @642,487 0x38
```

## Final answer

```
After pressing Hide, none of the seven buttons can be seen and clicked. I checked the page after the click:

- **Removed, Opacity 0, Visibility Hidden, Display None:** their labels disappeared from the page when Hide was clicked.
- **Zero Width:** still on the page, but it is 0 px wide (0×38).
- **Overlapped:** still on the page, but a layer called `div#hidingLayer` sits on top of it.
- **Offscreen:** moved to position -9999, -9999, outside the page, so no one can scroll to it.

Removed: not clickable
Zero Width: not clickable
Overlapped: not clickable
Opacity 0: not clickable
Visibility Hidden: not clickable
Display None: not clickable
Offscreen: not clickable

RESULT: success
```
