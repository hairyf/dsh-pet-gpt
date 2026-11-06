import AVFoundation
import CoreVideo
import Foundation

// Decodes a HEVC-with-alpha MOV through AVFoundation and proves that the
// platform really returns a transparent alpha plane at the expected geometry
// and frame count. ffprobe can read the metadata of a broken file; only a
// native decode shows what WKWebView will actually play.

func verify() throws {
    guard CommandLine.arguments.count == 5,
          let expectedFrames = Int(CommandLine.arguments[2]),
          let expectedDuration = Double(CommandLine.arguments[3]),
          let expectedWidth = Int(CommandLine.arguments[4]) else {
        throw NSError(domain: "usage: verify-alpha <mov> <frames> <duration> <width>", code: 1)
    }
    let height = expectedWidth * 360 / 640
    let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
    guard let track = asset.tracks(withMediaType: .video).first else {
        throw NSError(domain: "missing video track", code: 1)
    }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    ])
    reader.add(output)
    guard reader.startReading() else {
        throw reader.error ?? NSError(domain: "native decode did not start", code: 1)
    }

    var frames = 0
    var minimum: UInt8 = 255
    var maximum: UInt8 = 0
    while let sample = output.copyNextSampleBuffer() {
        guard let buffer = CMSampleBufferGetImageBuffer(sample) else {
            throw NSError(domain: "sample without a pixel buffer", code: 1)
        }
        let width = CVPixelBufferGetWidth(buffer)
        let bufferHeight = CVPixelBufferGetHeight(buffer)
        guard width == expectedWidth, bufferHeight == height else {
            throw NSError(domain: "decoded \(width)x\(bufferHeight), expected \(expectedWidth)x\(height)", code: 1)
        }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        guard let base = CVPixelBufferGetBaseAddress(buffer) else {
            CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
            throw NSError(domain: "missing decoded pixels", code: 1)
        }
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        for y in 0..<bufferHeight {
            for x in 0..<width {
                let alpha = bytes[y * stride + x * 4 + 3]
                minimum = min(minimum, alpha)
                maximum = max(maximum, alpha)
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
        frames += 1
    }
    guard reader.status == .completed else {
        throw reader.error ?? NSError(domain: "incomplete native decode", code: 1)
    }
    guard frames == expectedFrames,
          abs(asset.duration.seconds - expectedDuration) <= 1.0 / 12.0 + 0.05,
          minimum < 32, maximum > 223 else {
        throw NSError(domain: "alpha or timing mismatch: frames=\(frames)/\(expectedFrames), duration=\(asset.duration.seconds)/\(expectedDuration), alpha=\(minimum)...\(maximum)", code: 1)
    }
    print("verified HEVC-alpha \(CommandLine.arguments[1]): frames=\(frames), alpha=\(minimum)...\(maximum)")
}

do {
    try verify()
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
