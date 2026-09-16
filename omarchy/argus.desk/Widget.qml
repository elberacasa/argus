import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui

// Argus in the bar: what agents are doing on the invisible desk.
//
// The desk is a Hyprland headless monitor nobody looks at. Agents open real
// windows there -- browsers, native apps -- and act on them without touching
// the person's focus, cursor or screen. This widget is the window onto it:
// every desk window as a live card, captured by the compositor.
//
// The cards are view-only on purpose. A screencopy is pixels, not a surface, so
// nothing here can send input to an agent's window; watching can never
// disturb the work. Peek pulls the whole desk onto the person's monitor when
// they want to look closer, and Stop ends every lane argus owns.
Panel {
  id: root
  moduleName: "argus.desk"
  ipcTarget: "argus"
  manageIpc: false

  readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR") || "/tmp"
  readonly property string deskFile: runtimeDir + "/argus/desk.json"

  // From desk.json; empty when the desk is down.
  property string output: ""
  property int workspace: -1
  property bool peeking: false
  property bool busy: false
  property string message: ""

  readonly property bool deskUp: root.output !== ""
  // Every window argus routes to the desk carries its class, so the Wayland
  // toplevel list filtered by app id is exactly the agents' windows -- the
  // same rule the compositor uses, and never one of the person's own.
  readonly property string deskClass: "argus-desk"
  // A nest (a whole Hyprland with its own mouse, `argus nest`) is one window
  // of the nested compositor's backend, whose app id is fixed by Aquamarine.
  readonly property string nestClass: "aquamarine"
  readonly property var agentWindows: {
    if (!root.deskUp) return []
    return (ToplevelManager.toplevels.values || []).filter(function(t) {
      return t && (t.appId === root.deskClass || t.appId === root.nestClass)
    })
  }
  readonly property int count: root.agentWindows.length

  readonly property string glyph: "󰈈" // U+F0208 nf-md-eye

  function run(args, done) {
    if (root.busy) return
    root.busy = true
    root.message = ""
    proc.after = done || null
    proc.command = ["argus"].concat(args)
    proc.running = true
  }

  FileView {
    id: desk
    path: root.deskFile
    printErrors: false
    watchChanges: true
    onFileChanged: desk.reload()
    onLoaded: {
      try {
        var d = JSON.parse(desk.text())
        root.output = d.output || ""
        root.workspace = parseInt(d.workspace, 10)
        root.peeking = d.peek !== null && d.peek !== undefined
      } catch (e) {
        root.output = ""
      }
    }
    onLoadFailed: { root.output = ""; root.workspace = -1; root.peeking = false }
  }

  // desk.json is replaced by rename, and a missing file has nothing to watch.
  Timer {
    interval: 2000
    running: true
    repeat: true
    onTriggered: desk.reload()
  }

  Process {
    id: proc
    property var after: null
    stderr: StdioCollector { id: err }
    onExited: function(exitCode) {
      root.busy = false
      if (exitCode !== 0) root.message = (err.text || "argus failed").trim().split("\n").pop()
      desk.reload()
      if (proc.after) proc.after(exitCode)
    }
  }

  IpcHandler {
    target: "argus"
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function state(): string {
      return JSON.stringify({ deskUp: root.deskUp, output: root.output, workspace: root.workspace,
        peeking: root.peeking, windows: root.agentWindows.map(function(t) { return t.title }), opened: root.opened })
    }
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.count > 0 ? root.glyph + " " + root.count : root.glyph
    dimmed: !root.deskUp
    active: root.peeking
    tooltipText: !root.deskUp ? "Argus desk is down"
      : root.count === 0 ? "Argus desk is up, no agent windows"
      : root.count + " agent window" + (root.count === 1 ? "" : "s") + " on the desk"
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.MiddleButton && root.deskUp) root.run(["peek"])
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    // Wider once several agents are working, so each live card stays readable.
    contentWidth: panel.fittedContentWidth(Style.space(root.count > 1 ? 820 : 560))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if ((text === "p" || text === "P") && root.deskUp) root.run(["peek"])
      }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(10)

        Item {
          width: parent.width
          implicitHeight: Math.max(titleColumn.implicitHeight, live.implicitHeight)

          Column {
            id: titleColumn
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              textFormat: Text.PlainText
              text: "Argus"
              color: Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.title
              font.weight: Font.Medium
            }

            Text {
              textFormat: Text.PlainText
              text: !root.deskUp ? "The desk is down"
                : root.count === 0 ? "Desk on " + root.output + " · no agent windows yet"
                : root.count + " agent window" + (root.count === 1 ? "" : "s") + " · view only"
              color: Color.popups.text
              opacity: 0.62
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }
          }

          // A live dot while anything is on the desk.
          Row {
            id: live
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(6)
            visible: root.count > 0

            Rectangle {
              width: Style.space(8)
              height: width
              radius: width / 2
              anchors.verticalCenter: parent.verticalCenter
              color: Color.urgent
              SequentialAnimation on opacity {
                running: live.visible && root.opened
                loops: Animation.Infinite
                NumberAnimation { to: 0.25; duration: 700; easing.type: Easing.InOutSine }
                NumberAnimation { to: 1.0; duration: 700; easing.type: Easing.InOutSine }
              }
            }

            Text {
              textFormat: Text.PlainText
              text: "LIVE"
              color: Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              font.weight: Font.Medium
              font.letterSpacing: 1
            }
          }
        }

        // One live card per agent window. Two columns once there is more than one.
        Grid {
          id: grid
          width: parent.width
          visible: root.count > 0
          columns: root.count > 1 ? 2 : 1
          spacing: Style.space(8)

          Repeater {
            model: root.agentWindows

            Item {
              id: card
              required property var modelData
              readonly property real sourceAspect: 16 / 10
              width: (grid.width - grid.spacing * (grid.columns - 1)) / grid.columns
              height: frame.height + label.implicitHeight + Style.space(4)

              Rectangle {
                id: frame
                width: parent.width
                height: Math.round(width / card.sourceAspect)
                radius: Style.cornerRadius
                color: Qt.rgba(0, 0, 0, 0.35)
                border.width: 1
                border.color: Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.12)
                clip: true

                ScreencopyView {
                  anchors.fill: parent
                  anchors.margins: 1
                  captureSource: root.opened ? card.modelData : null
                  live: root.opened
                }
              }

              Text {
                id: label
                anchors.top: frame.bottom
                anchors.topMargin: Style.space(4)
                width: parent.width
                textFormat: Text.PlainText
                elide: Text.ElideRight
                text: card.modelData.appId === root.nestClass ? "Nested desktop · own mouse" : (card.modelData.title || card.modelData.appId)
                color: Color.popups.text
                opacity: 0.72
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }
          }
        }

        Text {
          visible: root.count === 0
          width: parent.width
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          text: root.deskUp
            ? "Agents run here without touching your screen. Try: argus --desk open <url>"
            : "Bring the desk up to give agents a monitor of their own."
          color: Color.popups.text
          opacity: 0.62
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Row {
          spacing: Style.space(8)

          Button {
            visible: !root.deskUp
            text: "Start desk"
            bordered: true
            foreground: Color.popups.text
            fontFamily: Style.font.family
            fontSize: Style.font.bodySmall
            onClicked: root.run(["desk", "up"])
          }

          Button {
            visible: root.deskUp
            text: root.peeking ? "Send back" : "Peek"
            bordered: true
            foreground: Color.popups.text
            fontFamily: Style.font.family
            fontSize: Style.font.bodySmall
            onClicked: root.run(["peek"], function() { root.close() })
          }

          Button {
            visible: root.deskUp
            text: "Stop agents"
            bordered: true
            foreground: Color.urgent
            fontFamily: Style.font.family
            fontSize: Style.font.bodySmall
            onClicked: root.run(["desk", "down"])
          }
        }

        Text {
          visible: root.message !== ""
          width: parent.width
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          text: root.message
          color: Color.urgent
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
