// Claude Code usage for Herdr. One mod, three views, picked by where it is shown:
//   mod.open (a popup)                        the full breakdown     view.popup
//   props { view: "panel" } in a pane/block   a narrow panel         view.panel
//   a layout's floating block (placement())   an edge drawer         view.drawer
// Whichever copies are open, one of them collects (data.js); all of them draw.
import { View } from "gpui-kit";
import { props, placement } from "herdr";
import { Collector } from "./data.js";
import * as view from "./view.js";

export default class ClaudeUsage extends View {
  init(_props, cx) {
    this.props = props() ?? {};
    this.collector = new Collector();
    this.collector.start(cx);
  }

  render() {
    const place = placement();
    if (place) return view.drawer(place);
    if (this.props.view === "panel") return view.panel();
    return view.popup(this.props.overlay);
  }

  close() {
    this.collector.release();
  }
}
