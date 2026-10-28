// Capture several macOS displays at once and write tagged JPEG frames to stdout.
//
// This replaces one-ffmpeg-per-display, which cannot work. bin/scc-capture-test
// measured it: every display captures alone in about 600ms, and *two* at once
// wedge indefinitely — ffmpeg's avfoundation screen input is exclusive, and the
// second capture takes the first one down with it rather than failing.
//
// ScreenCaptureKit is built for the case that broke: one process, one capture
// engine, an independent SCStream per display. It also hands over frames the
// compositor already produced, so there is no second scaling pass and no
// per-display subprocess.
//
// Output framing, repeated per frame:
//
//     "SCCF"            4 bytes, magic, so a desynchronised reader can resync
//     ordinal           uint32 little-endian, which display this is
//     length            uint32 little-endian, JPEG byte count
//     jpeg              length bytes
//
// The ordinal is the display's index in CGGetActiveDisplayList, which is the
// same numbering macos://display/N uses everywhere else in this bridge.
//
//   sck-capture --displays 0,1,2,3,4 --width 1600 --fps 10 --quality 0.6

import AVFoundation
import CoreImage
import Foundation
import ScreenCaptureKit

// MARK: - Arguments

func argument(_ name: String, _ fallback: String) -> String {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: "--\(name)"), index + 1 < args.count else { return fallback }
    return args[index + 1]
}

let wantedOrdinals = argument("displays", "0")
    .split(separator: ",")
    .compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
let targetWidth = Int(argument("width", "1600")) ?? 1600
let fps = Int(argument("fps", "10")) ?? 10
let quality = Double(argument("quality", "0.6")) ?? 0.6

// MARK: - stdout framing
//
// Several streams deliver on their own queues, so writes are serialised through
// one lock. A torn frame here would desynchronise the reader for every display,
// not just the one that raced.

let stdoutLock = NSLock()
let stdoutHandle = FileHandle.standardOutput

func emit(ordinal: Int, jpeg: Data) {
    var header = Data("SCCF".utf8)
    var ordinalLE = UInt32(ordinal).littleEndian
    var lengthLE = UInt32(jpeg.count).littleEndian
    withUnsafeBytes(of: &ordinalLE) { header.append(contentsOf: $0) }
    withUnsafeBytes(of: &lengthLE) { header.append(contentsOf: $0) }
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    stdoutHandle.write(header)
    stdoutHandle.write(jpeg)
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
}

// MARK: - One display

final class DisplayCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    let ordinal: Int
    private let context: CIContext
    private let quality: Double
    private var stream: SCStream?

    init(ordinal: Int, quality: Double) {
        self.ordinal = ordinal
        self.quality = quality
        // A GPU-backed context; the pixel buffer is already on the GPU, so
        // encoding from it avoids a readback per frame.
        self.context = CIContext(options: [.useSoftwareRenderer: false])
        super.init()
    }

    func start(display: SCDisplay, width: Int, fps: Int) throws {
        let configuration = SCStreamConfiguration()
        let scale = Double(width) / Double(display.width)
        configuration.width = width
        configuration.height = Int((Double(display.height) * scale).rounded())
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        configuration.showsCursor = true
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        // Frames are dropped rather than queued when the encoder falls behind.
        // A backlog would show the headset a stale desktop, which is worse than
        // showing it fewer frames.
        configuration.queueDepth = 3

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen,
                                   sampleHandlerQueue: DispatchQueue(label: "scc.capture.\(ordinal)"))
        self.stream = stream
        stream.startCapture { error in
            if let error { log("[sck] display \(self.ordinal) failed to start: \(error.localizedDescription)") }
            else { log("[sck] display \(self.ordinal) capturing at \(configuration.width)x\(configuration.height)") }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }

        // ScreenCaptureKit emits frames whose status is not `.complete` — most
        // often `.idle`, meaning nothing on that display changed. Those carry no
        // usable surface, so encoding them would emit a blank frame rather than
        // no frame.
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: raw) == .complete,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let jpeg = context.jpegRepresentation(
            of: image,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality]
        ) else { return }

        emit(ordinal: ordinal, jpeg: jpeg)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("[sck] display \(ordinal) stopped: \(error.localizedDescription)")
    }
}

// MARK: - Wire ordinals to displays

var captures: [DisplayCapture] = []

Task {
    do {
        // CGGetActiveDisplayList defines the ordinal numbering used by
        // macos://display/N, so SCDisplay is matched to it by displayID rather
        // than by SCShareableContent's own ordering, which is unspecified.
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let byId = Dictionary(uniqueKeysWithValues: content.displays.map { ($0.displayID, $0) })

        for ordinal in wantedOrdinals {
            guard ordinal < ids.count, let display = byId[ids[ordinal]] else {
                log("[sck] display \(ordinal) does not exist")
                continue
            }
            let capture = DisplayCapture(ordinal: ordinal, quality: quality)
            captures.append(capture)
            try capture.start(display: display, width: targetWidth, fps: fps)
        }

        if captures.isEmpty {
            log("[sck] nothing to capture")
            exit(1)
        }
        log("[sck] ready: \(captures.count) display(s)")
    } catch {
        log("[sck] fatal: \(error.localizedDescription)")
        log("[sck] Screen Recording permission is required for the app running this.")
        exit(2)
    }
}

RunLoop.main.run()
