// Enumerate displays in CGGetActiveDisplayList order.
//
// This is the order ffmpeg's avfoundation input uses to number "Capture screen
// N", so index here is the ordinal a screen is addressed by as
// macos://display/N. Reading it directly beats inferring it: an earlier attempt
// probed each capture device for its frame size, which needs exclusive access
// to a device the running host already holds, and hung.
import CoreGraphics
import Foundation

var count: UInt32 = 0
CGGetActiveDisplayList(0, nil, &count)
var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
CGGetActiveDisplayList(count, &ids, &count)

var out: [[String: Any]] = []
for (index, id) in ids.enumerated() {
    let mode = CGDisplayCopyDisplayMode(id)
    out.append([
        "ordinal": index,
        "displayID": Int(id),
        "pixelWidth": mode?.pixelWidth ?? 0,
        "pixelHeight": mode?.pixelHeight ?? 0,
        "pointWidth": mode?.width ?? 0,
        "pointHeight": mode?.height ?? 0,
        "main": CGDisplayIsMain(id) != 0,
        "builtin": CGDisplayIsBuiltin(id) != 0
    ])
}
let data = try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys])
print(String(data: data, encoding: .utf8)!)
