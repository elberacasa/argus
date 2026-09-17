# Argus · Text Input · round 2

**Goal met (read from the page): yes** (button reads "Argus") · claimed success · 2 tool calls · 8.3 s · $0.028

## 1. `browser_open`

```json
{
  "url": "http://127.0.0.1:40695/textinput"
}
```

```
lane main opened
  → http://127.0.0.1:40695/textinput
  title "Text Input"
  + "UITAP"
  + "Home"
  + "Resources"
  + "Text Input"
  + "Entering text with physical keyboard can be different from sending DOM events to an element. This page is specifically desined to illustr..."
  + "Scenario"
  + "Record setting text into the input field and pressing the button."
  + "Then execute your test to make sure that the button name is changing."
  + "Playground"
  + "Set New Button Name"
  + "Button That Should Change it's Name Based on Input Value"
  + "Star"
  + … 3 more

Text Input (1280x800)
landmarks:
  navigation e0.30
  form e0.7
  contentinfo e0.70
headings:
  Text Input e0.44
  Scenario e0.48
  Playground e0.57
fields:
  textbox:Set New Button Name e0.8
actions:
  link:UITAP e0.31
  link:Home e0.38
  link:Resources e0.6
  button:Button That Should Change it's Name Based on Input Value e0.64
  link:Star inflectra/ui-test-automation-playground on GitHub e0.79
  link:Fork the website on GitHub e0.88
  link:Rapise e0.93
  link:Inflectra Corporation e0.96
  link:Apache License 2.0 e0.102
```

## 2. `browser_act`

```json
{
  "steps": [
    {
      "type": [
        "e0.8",
        "Argus"
      ]
    },
    {
      "click": "e0.64",
      "expect": {
        "appears": {
          "role": "button",
          "name": "Argus"
        }
      }
    }
  ]
}
```

```
✓ type textbox:Set New Button Name e0.8  162ms
  = textbox:Set New Button Name: "Argus"
✓ click button:Button That Should Change it's Name Based on Input Value e0.64  161ms
  + "Argus"
  − "Button That Should Change it's Name Based on Input Value"
```

## Final answer

```
I typed "Argus" into the "Set New Button Name" field and clicked the button. Its label changed from "Button That Should Change it's Name Based on Input Value" to "Argus". The check I set on the click passed, which confirmed a button named "Argus" was on the page.

RESULT: success
```
