#if Talk && canImport(ElevenLabsKit) && (os(iOS) || os(macOS))
import Foundation
import Testing
@testable import OpenClawKit

@MainActor
private final class RealtimePCMPlaybackBackend {
    private(set) var scheduledFrames: [Data] = []
    private(set) var completions: [@Sendable () -> Void] = []
    private(set) var activeCount = 0
    private(set) var maxActiveCount = 0

    func prepare(sampleRate _: Double) throws {}

    func schedule(
        data: Data,
        sampleRate _: Double,
        completion: @escaping @Sendable () -> Void) throws
    {
        self.scheduledFrames.append(data)
        self.activeCount += 1
        self.maxActiveCount = max(self.maxActiveCount, self.activeCount)
        self.completions.append { [weak self] in
            Task { @MainActor in
                self?.activeCount -= 1
                completion()
            }
        }
    }

    func stop() {
        self.activeCount = 0
    }

    func complete(at index: Int = 0) {
        self.completions.remove(at: index)()
    }

    func takeCompletion(at index: Int = 0) -> @Sendable () -> Void {
        self.completions.remove(at: index)
    }
}

@MainActor
private final class RealtimePCMPlaybackResultProbe {
    private(set) var results: [StreamingPlaybackResult] = []

    func record(_ result: StreamingPlaybackResult) {
        self.results.append(result)
    }
}

@MainActor
private func makeRealtimePCMPlayer(
    backend: RealtimePCMPlaybackBackend) -> RealtimePCMStreamingAudioPlayer
{
    RealtimePCMStreamingAudioPlayer(
        preparePlayback: backend.prepare,
        scheduleFrame: backend.schedule,
        stopPlayback: backend.stop,
        playbackTime: { nil })
}

@MainActor
private func waitUntil(
    _ predicate: @escaping @MainActor () -> Bool) async
{
    for _ in 0..<100 where !predicate() {
        await Task.yield()
    }
}

@MainActor
struct RealtimePCMStreamingAudioPlayerTests {
    private let sampleRate = 8000.0
    private var frameBytes: Int {
        Int(self.sampleRate * RealtimePCMStreamingAudioPlayer.frameDurationSeconds) * 2
    }

    @Test func `withheld completions cap scheduling and one completion admits one frame`() async {
        let backend = RealtimePCMPlaybackBackend()
        let player = makeRealtimePCMPlayer(backend: backend)
        let probe = RealtimePCMPlaybackResultProbe()
        var continuation: AsyncThrowingStream<Data, Error>.Continuation?
        let stream = AsyncThrowingStream<Data, Error> { continuation = $0 }
        let playback = Task {
            let result = await player.play(stream: stream, sampleRate: self.sampleRate)
            probe.record(result)
        }

        continuation?.yield(Data(repeating: 1, count: self.frameBytes * 5))
        continuation?.finish()
        await waitUntil { backend.scheduledFrames.count == 3 }
        #expect(backend.scheduledFrames.count == 3)
        #expect(backend.maxActiveCount == 3)
        #expect(probe.results.isEmpty)

        backend.complete()
        await waitUntil { backend.scheduledFrames.count == 4 }
        #expect(backend.scheduledFrames.count == 4)
        #expect(backend.maxActiveCount == 3)
        #expect(probe.results.isEmpty)

        while !backend.completions.isEmpty {
            backend.complete()
            await Task.yield()
        }
        await playback.value
        #expect(probe.results.count == 1)
        #expect(probe.results.first?.finished == true)
        #expect(probe.results.first?.interruptedAt == nil)
        #expect(backend.scheduledFrames.count == 5)
        #expect(backend.scheduledFrames.allSatisfy { $0.count == self.frameBytes })
    }

    @Test func `playback finishes only after input and every scheduled frame complete`() async {
        let backend = RealtimePCMPlaybackBackend()
        let player = makeRealtimePCMPlayer(backend: backend)
        let probe = RealtimePCMPlaybackResultProbe()
        var continuation: AsyncThrowingStream<Data, Error>.Continuation?
        let stream = AsyncThrowingStream<Data, Error> { continuation = $0 }
        let playback = Task {
            let result = await player.play(stream: stream, sampleRate: self.sampleRate)
            probe.record(result)
        }

        continuation?.yield(Data(repeating: 1, count: self.frameBytes * 2))
        continuation?.finish()
        await waitUntil { backend.scheduledFrames.count == 2 }
        #expect(backend.completions.count == 2)
        #expect(probe.results.isEmpty)

        backend.complete()
        await Task.yield()
        #expect(backend.completions.count == 1)
        #expect(probe.results.isEmpty)
        backend.complete()
        await playback.value
        #expect(probe.results.count == 1)
        #expect(probe.results.first?.finished == true)
        #expect(probe.results.first?.interruptedAt == nil)
    }

    @Test func `stop restart ignores stale buffer completions`() async {
        let backend = RealtimePCMPlaybackBackend()
        let player = makeRealtimePCMPlayer(backend: backend)
        var firstContinuation: AsyncThrowingStream<Data, Error>.Continuation?
        let firstStream = AsyncThrowingStream<Data, Error> { firstContinuation = $0 }
        let firstProbe = RealtimePCMPlaybackResultProbe()
        let firstPlayback = Task {
            let result = await player.play(stream: firstStream, sampleRate: self.sampleRate)
            firstProbe.record(result)
        }
        firstContinuation?.yield(Data(repeating: 1, count: self.frameBytes))
        await waitUntil { backend.completions.count == 1 }
        let staleCompletion = backend.takeCompletion()

        _ = player.stop()
        await firstPlayback.value
        #expect(firstProbe.results.map(\.finished) == [false])

        var secondContinuation: AsyncThrowingStream<Data, Error>.Continuation?
        let secondStream = AsyncThrowingStream<Data, Error> { secondContinuation = $0 }
        let probe = RealtimePCMPlaybackResultProbe()
        let secondPlayback = Task {
            let result = await player.play(stream: secondStream, sampleRate: self.sampleRate)
            probe.record(result)
        }
        secondContinuation?.yield(Data(repeating: 2, count: self.frameBytes * 5))
        secondContinuation?.finish()
        await waitUntil { backend.completions.count == 3 }

        staleCompletion()
        await Task.yield()
        #expect(backend.scheduledFrames.count == 4)
        #expect(backend.completions.count == 3)
        #expect(firstProbe.results.map(\.finished) == [false])
        #expect(probe.results.isEmpty)
        backend.complete()
        await waitUntil { backend.scheduledFrames.count == 5 }
        #expect(backend.scheduledFrames.count == 5)
        #expect(probe.results.isEmpty)
        while !backend.completions.isEmpty {
            backend.complete()
            await Task.yield()
        }
        await secondPlayback.value
        #expect(probe.results.count == 1)
        #expect(probe.results.first?.finished == true)
        #expect(probe.results.first?.interruptedAt == nil)
    }

    @Test func `stop resumes the active playback exactly once`() async {
        let backend = RealtimePCMPlaybackBackend()
        let player = makeRealtimePCMPlayer(backend: backend)
        let probe = RealtimePCMPlaybackResultProbe()
        var continuation: AsyncThrowingStream<Data, Error>.Continuation?
        let stream = AsyncThrowingStream<Data, Error> { continuation = $0 }
        let playback = Task {
            let result = await player.play(stream: stream, sampleRate: self.sampleRate)
            probe.record(result)
        }
        continuation?.yield(Data(repeating: 1, count: self.frameBytes * 5))
        await waitUntil { backend.scheduledFrames.count == 3 }

        _ = player.stop()
        _ = player.stop()
        await playback.value

        #expect(probe.results.count == 1)
        #expect(probe.results.first?.finished == false)
    }
}
#endif
