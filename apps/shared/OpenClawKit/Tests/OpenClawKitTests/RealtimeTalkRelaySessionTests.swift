import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

@MainActor
private final class UnusedPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    func play(stream: AsyncThrowingStream<Data, Error>, sampleRate: Double) async -> StreamingPlaybackResult {
        fatalError("Playback is not used by this test")
    }

    func stop() -> Double? {
        nil
    }
}

@MainActor
private final class DrainingPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    func play(stream: AsyncThrowingStream<Data, Error>, sampleRate _: Double) async -> StreamingPlaybackResult {
        do {
            for try await _ in stream {}
        } catch {}
        return StreamingPlaybackResult(finished: true, interruptedAt: nil)
    }

    func stop() -> Double? {
        nil
    }
}

@MainActor
private final class StalledPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    private(set) var playCount = 0
    private(set) var stopCount = 0
    private var continuation: CheckedContinuation<StreamingPlaybackResult, Never>?

    func play(
        stream _: AsyncThrowingStream<Data, Error>,
        sampleRate _: Double) async -> StreamingPlaybackResult
    {
        self.playCount += 1
        return await withCheckedContinuation { self.continuation = $0 }
    }

    func stop() -> Double? {
        self.stopCount += 1
        let continuation = self.continuation
        self.continuation = nil
        continuation?.resume(returning: StreamingPlaybackResult(finished: false, interruptedAt: nil))
        return nil
    }
}

private struct RealtimeRelayTestTimeout: Error, CustomStringConvertible {
    let operation: String

    var description: String {
        "timed out waiting for \(self.operation)"
    }
}

private final class RealtimeRelayTestSignal<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var values: [Value] = []

    func send(_ value: Value) {
        self.lock.withLock {
            self.values.append(value)
        }
        self.semaphore.signal()
    }

    func next(_ operation: String) async throws -> Value {
        let semaphore = self.semaphore
        let result = await Task.detached {
            Self.wait(for: semaphore)
        }.value
        guard result == .success else {
            throw RealtimeRelayTestTimeout(operation: operation)
        }
        return self.lock.withLock {
            self.values.removeFirst()
        }
    }

    private static func wait(for semaphore: DispatchSemaphore) -> DispatchTimeoutResult {
        semaphore.wait(timeout: .now() + 1)
    }
}

@MainActor
private final class IndexedPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    private(set) var activePlaybackIndexes: Set<Int> = []
    private var continuations: [Int: CheckedContinuation<StreamingPlaybackResult, Never>] = [:]
    private let playbackStarted = RealtimeRelayTestSignal<Int>()
    private let mainActorCheckpoint = RealtimeRelayTestSignal<Int>()
    private var nextPlaybackIndex = 0

    func play(
        stream _: AsyncThrowingStream<Data, Error>,
        sampleRate _: Double) async -> StreamingPlaybackResult
    {
        let index = self.nextPlaybackIndex
        self.nextPlaybackIndex += 1
        self.activePlaybackIndexes.insert(index)
        let result = await withCheckedContinuation { continuation in
            self.continuations[index] = continuation
            self.playbackStarted.send(index)
        }
        self.mainActorCheckpoint.send(index)
        return result
    }

    func stop() -> Double? {
        nil
    }

    func waitForPlayback(_ expectedIndex: Int) async throws {
        let index = try await self.playbackStarted.next("playback \(expectedIndex) to start")
        guard index == expectedIndex else {
            throw RealtimeRelayTestTimeout(operation: "playback \(expectedIndex), got \(index)")
        }
    }

    func complete(_ index: Int) {
        self.activePlaybackIndexes.remove(index)
        self.continuations.removeValue(forKey: index)?.resume(
            returning: StreamingPlaybackResult(finished: true, interruptedAt: nil))
    }

    func waitUntilCompletionWasHandled(_ expectedIndex: Int) async throws {
        let index = try await self.mainActorCheckpoint.next("playback \(expectedIndex) completion")
        guard index == expectedIndex else {
            throw RealtimeRelayTestTimeout(
                operation: "playback \(expectedIndex) completion, got \(index)")
        }
    }
}

@MainActor
private final class TestRealtimeTalkAudioCapture: RealtimeTalkAudioCapturing {
    var suppressesInputDuringOutput = false
    private(set) var isStarted = false
    private(set) var startCount = 0
    private(set) var stopCount = 0
    private var onFailure: (@MainActor (String) -> Void)?

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure: @escaping @MainActor (String) -> Void) throws
    {
        self.isStarted = true
        self.startCount += 1
        self.onFailure = onFailure
    }

    func stop() {
        self.isStarted = false
        self.stopCount += 1
        self.onFailure = nil
    }

    func fail(_ message: String) {
        self.onFailure?(message)
    }
}

private actor RealtimeRelayStartupBarrier {
    private var entered = false
    private var released = false
    private var releaseWaiter: CheckedContinuation<Void, Never>?
    private let enteredSignal = RealtimeRelayTestSignal<Void>()

    func suspend() async {
        self.entered = true
        self.enteredSignal.send(())
        if self.released {
            return
        }
        await withCheckedContinuation { self.releaseWaiter = $0 }
    }

    func waitUntilEntered() async {
        if self.entered {
            return
        }
        do {
            _ = try await self.enteredSignal.next("request barrier entry")
        } catch {
            self.release()
            Issue.record(error)
        }
    }

    func release() {
        self.released = true
        self.releaseWaiter?.resume()
        self.releaseWaiter = nil
    }
}

private struct RealtimeRelayStartupRequest: Sendable {
    let method: String
    let params: [String: AnyCodable]?
}

private actor RealtimeRelayStartupRequestLog {
    private var requests: [RealtimeRelayStartupRequest] = []

    func record(method: String, params: [String: AnyCodable]?) {
        self.requests.append(RealtimeRelayStartupRequest(method: method, params: params))
    }

    func snapshot() -> [RealtimeRelayStartupRequest] {
        self.requests
    }
}

private enum ControlledAudioAppendBehavior {
    case suspended
    case requestFailure
    case malformedResponse
}

private actor ControlledRealtimeAudioRequests {
    private let behavior: ControlledAudioAppendBehavior
    private var methods: [String] = []
    private var appendContinuations: [CheckedContinuation<Data, any Error>] = []
    private let requestObserved = RealtimeRelayTestSignal<Int>()

    init(behavior: ControlledAudioAppendBehavior = .suspended) {
        self.behavior = behavior
    }

    func request(method: String) async throws -> Data {
        self.methods.append(method)
        self.requestObserved.send(self.methods.count)
        guard method == "talk.session.appendAudio" else {
            return Data("{\"ok\":true}".utf8)
        }
        switch self.behavior {
        case .suspended:
            return try await withCheckedThrowingContinuation { continuation in
                self.appendContinuations.append(continuation)
            }
        case .requestFailure:
            throw URLError(.badServerResponse)
        case .malformedResponse:
            return Data("{}".utf8)
        }
    }

    func waitForRequestCount(_ expectedCount: Int) async throws {
        while self.methods.count < expectedCount {
            _ = try await self.requestObserved.next("\(expectedCount) relay requests")
        }
    }

    func snapshot() -> [String] {
        self.methods
    }

    func succeedPendingAppends() {
        let continuations = self.appendContinuations
        self.appendContinuations.removeAll()
        continuations.forEach { $0.resume(returning: Data("{\"ok\":true}".utf8)) }
    }
}

private actor RealtimeRelayRouteFlag {
    private var isCurrent = true

    func expire() {
        self.isCurrent = false
    }

    func value() -> Bool {
        self.isCurrent
    }
}

private actor RealtimeRelayEventSource {
    private var continuation: AsyncStream<EventFrame>.Continuation?

    func stream() -> AsyncStream<EventFrame> {
        AsyncStream { self.continuation = $0 }
    }

    func finish() {
        self.continuation?.finish()
    }
}

private func unusedRealtimeRelayTransport() -> RealtimeTalkRelayTransport {
    RealtimeTalkRelayTransport(
        subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
        request: { _, _, _ in throw CancellationError() })
}

private func outputAudioEvent(
    turnId: String,
    data: Data = Data([0x01]),
    relaySessionId: String = "relay-1") -> EventFrame
{
    EventFrame(
        type: "event",
        event: "talk.event",
        payload: AnyCodable([
            "relaySessionId": relaySessionId,
            "type": "audio",
            "audioBase64": data.base64EncodedString(),
            "talkEvent": ["turnId": turnId],
        ]),
        seq: nil,
        stateversion: nil)
}

@MainActor
struct RealtimeTalkRelaySessionTests {
    private func makeIdleCancellationSession(
        _ onSpeakingChanged: @escaping (Bool) -> Void) -> RealtimeTalkRelaySession
    {
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { _, _, _ in Data("{\"ok\":true}".utf8) })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: onSpeakingChanged)
        session._test_setRelaySessionId("relay-1")
        return session
    }

    @Test func `transcript callback carries typed partial and final values`() async {
        var transcripts: [RealtimeTalkTranscript] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in },
            onTranscript: { transcripts.append($0) })
        session._test_setRelaySessionId("relay-1")

        for isFinal in [false, true] {
            await session._test_handleGatewayEvent(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "transcript",
                    "role": "user",
                    "text": isFinal ? "hello" : "hel",
                    "final": isFinal,
                ]),
                seq: nil,
                stateversion: nil))
        }

        #expect(transcripts == [
            RealtimeTalkTranscript(role: "user", text: "hel", isFinal: false),
            RealtimeTalkTranscript(role: "user", text: "hello", isFinal: true),
        ])
    }

    @Test func `input pause and resume are idempotent and keep relay alive`() throws {
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        try session.setInputPaused(true)
        try session.setInputPaused(true)
        try session.setInputPaused(false)
        try session.setInputPaused(false)

        #expect(audioCapture.stopCount == 2)
        #expect(audioCapture.startCount == 1)
        #expect(audioCapture.isStarted)
    }

    @Test func `output playback finish clears barge in start time`() {
        var speakingStates: [Bool] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })

        session._test_markOutputAudioStarted(nowMs: 100)
        #expect(session._test_isOutputPlaying())
        #expect(session._test_outputStartedAtMs() == 100)

        session._test_markOutputPlaybackFinished()
        #expect(!session._test_isOutputPlaying())
        #expect(session._test_outputStartedAtMs() == nil)
        #expect(speakingStates == [false])

        session._test_markOutputAudioStarted(nowMs: 500)
        #expect(session._test_outputStartedAtMs() == 500)
    }

    @Test func `playback mark is acknowledged after output finishes`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "xai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        session._test_markOutputAudioStarted(nowMs: 100)

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "mark",
                "markName": "audio-1",
            ]),
            seq: nil,
            stateversion: nil))
        await Task.yield()
        #expect(await requests.snapshot().isEmpty)

        session._test_markOutputPlaybackFinished()
        for _ in 0..<10 {
            if await !(requests.snapshot()).isEmpty { break }
            await Task.yield()
        }

        let recorded = await requests.snapshot()
        #expect(recorded.count == 1)
        let request = try #require(recorded.first)
        #expect(request.method == "talk.session.acknowledgeMark")
        #expect(request.params?["sessionId"]?.stringValue == "relay-1")
        #expect(request.params?["markName"]?.stringValue == "audio-1")
    }
}

extension RealtimeTalkRelaySessionTests {
    @Test func `output buffer cap plus one terminates visibly and requests recovery`() async {
        let requests = RealtimeRelayStartupRequestLog()
        let player = StalledPCMStreamingAudioPlayer()
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: player,
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        for _ in 0...32 {
            await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        }
        for _ in 0..<10 where terminations.isEmpty {
            await Task.yield()
        }

        #expect(issues.map(\.phase) == ["output-playback"])
        #expect(terminations == [.outputPlaybackOverflow])
        #expect(player.stopCount == 1)
        for _ in 0..<10 {
            if await requests.snapshot().contains(where: { $0.method == "talk.session.close" }) {
                break
            }
            await Task.yield()
        }
        #expect(await requests.snapshot().contains(where: { $0.method == "talk.session.close" }))
    }

    @Test func `new turn supersedes a stalled prior playback drain`() async {
        let player = StalledPCMStreamingAudioPlayer()
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: player,
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-a"))
        await Task.yield()
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-b"))
        await Task.yield()

        #expect(player.playCount == 2)
        #expect(player.stopCount == 1)
        session.stop()
    }

    @Test func `stale player completion cannot finish replacement turn playback`() async throws {
        let player = IndexedPCMStreamingAudioPlayer()
        var speakingStates: [Bool] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: player,
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-a"))
        try await player.waitForPlayback(0)
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-b"))
        try await player.waitForPlayback(1)

        #expect(player.activePlaybackIndexes.contains(1))
        #expect(speakingStates == [true, false, true])

        player.complete(0)
        try await player.waitUntilCompletionWasHandled(0)

        #expect(player.activePlaybackIndexes.contains(1))
        #expect(session._test_isOutputPlaying())
        #expect(speakingStates == [true, false, true])

        player.complete(1)
        try await player.waitUntilCompletionWasHandled(1)

        #expect(!session._test_isOutputPlaying())
        #expect(speakingStates == [true, false, true, false])
    }

    @Test func `stale relay session cannot clear successor playback`() async {
        var speakingStates: [Bool] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: StalledPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-a"))
        session._test_setRelaySessionId("relay-2")
        await session._test_handleGatewayEvent(
            outputAudioEvent(turnId: "turn-b", relaySessionId: "relay-2"))

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "clear",
                "talkEvent": ["turnId": "turn-a"],
            ]),
            seq: nil,
            stateversion: nil))

        #expect(session._test_isOutputPlaying())
        #expect(speakingStates == [true, false, true])
        session.stop()
    }

    @Test func `output cancellation fences delayed audio and preserves exact identity`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")
        let audio: (String) -> EventFrame = { turnId in
            EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "audio",
                    "audioBase64": Data([0x01]).base64EncodedString(),
                    "talkEvent": ["turnId": turnId],
                ]),
                seq: nil,
                stateversion: nil)
        }
        let clear: (String) -> EventFrame = { turnId in
            EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "clear",
                    "talkEvent": ["turnId": turnId],
                ]),
                seq: nil,
                stateversion: nil)
        }

        await session._test_handleGatewayEvent(audio("turn-7"))
        session.cancelOutput(reason: "barge-in")
        for _ in 0..<10 {
            if await !requests.snapshot().isEmpty { break }
            await Task.yield()
        }
        let request = try #require(await requests.snapshot().first)
        #expect(request.method == "talk.session.cancelOutput")
        #expect(request.params?["sessionId"]?.stringValue == "relay-1")
        #expect(request.params?["turnId"]?.stringValue == "turn-7")
        #expect(request.params?["reason"]?.stringValue == "barge-in")

        await session._test_handleGatewayEvent(audio("turn-7"))
        await session._test_handleGatewayEvent(audio("turn-8"))
        #expect(speakingStates.first == true)
        #expect(!speakingStates.dropFirst().contains(true))
        await session._test_handleGatewayEvent(clear("turn-7"))
        await session._test_handleGatewayEvent(audio("turn-7"))
        #expect(speakingStates == [true, false])
        await session._test_handleGatewayEvent(audio("turn-8"))
        #expect(speakingStates == [true, false, true])
        await session._test_handleGatewayEvent(clear("turn-7"))
        #expect(speakingStates == [true, false, true])
        await session._test_handleGatewayEvent(clear("turn-8"))
        #expect(speakingStates == [true, false, true, false])
    }

    @Test func `cancellation sends the active turn identity`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x01]).base64EncodedString(),
                "talkEvent": ["turnId": "turn-7"],
            ]),
            seq: nil,
            stateversion: nil))

        session.cancelOutput(reason: "barge-in")
        for _ in 0..<10 {
            if await !requests.snapshot().isEmpty { break }
            await Task.yield()
        }
        let request = try #require(await requests.snapshot().first)
        #expect(request.params?["turnId"]?.stringValue == "turn-7")
    }

    @Test func `idle cancellation and pause retain the relay without false interruption`() async {
        let requests = RealtimeRelayStartupRequestLog()
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")

        session.setOutputPaused(true)
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        #expect(speakingStates.isEmpty)
        #expect(await requests.snapshot().isEmpty)
        session.setOutputPaused(false)
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-2"))
        #expect(speakingStates == [true])
        #expect(await requests.snapshot().isEmpty)
    }

    @Test(arguments: ["stale", "idle"])
    func `non applied cancellation retires the wait without reopening the old turn`(
        status: String) async throws
    {
        let barrier = RealtimeRelayStartupBarrier()
        let speakingChanged = RealtimeRelayTestSignal<Bool>()
        var speakingStates: [Bool] = []
        let requests = RealtimeRelayStartupRequestLog()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    await barrier.suspend()
                    return Data("{\"status\":\"\(status)\"}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: {
                speakingStates.append($0)
                speakingChanged.send($0)
            })
        session._test_setRelaySessionId("relay-1")
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        var successor: Task<Void, Never>?
        do {
            #expect(try await speakingChanged.next("initial output") == true)

            #expect(session.cancelOutput())
            #expect(try await speakingChanged.next("cancellation fence") == false)
            await barrier.waitUntilEntered()
            #expect(await requests.snapshot().map(\.method) == ["talk.session.cancelOutput"])
            #expect(session._test_enqueueMicrophoneFrame(Data([0x01])) == nil)
            await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-2"))
            #expect(speakingStates == [true, false])

            await barrier.release()
            await session._test_waitForOutputCancellation()
            await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
            successor = Task { @MainActor in
                await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-2"))
            }
            #expect(try await speakingChanged.next("successor output") == true)
            await successor?.value
        } catch {
            await barrier.release()
            await session._test_waitForOutputCancellation()
            successor?.cancel()
            await successor?.value
            session.stop()
            throw error
        }

        #expect(speakingStates == [true, false, true])
    }

    @Test func `cancellation without active identified output is a no-op`() async {
        var speakingStates: [Bool] = []
        let session = self.makeIdleCancellationSession { speakingStates.append($0) }
        #expect(!session.cancelOutput(reason: "barge-in"))
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        #expect(speakingStates == [true])

        var unfencedStates: [Bool] = []
        let unfenced = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { unfencedStates.append($0) })
        #expect(!unfenced.cancelOutput())
        unfenced._test_setRelaySessionId("relay-1")
        await unfenced._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        #expect(unfencedStates == [true])
    }

    @Test func `turn-scoped audio without a turn id terminates visibly`() async {
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: StalledPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x01]).base64EncodedString(),
            ]),
            seq: nil,
            stateversion: nil))

        #expect(issues.map(\.phase) == ["output-playback"])
        #expect(terminations == [.outputPlaybackOverflow])
    }

    @Test func `oversized current audio terminates but oversized cancelled audio stays fenced`() async {
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { _, _, _ in Data("{\"ok\":true}".utf8) }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: StalledPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-a"))
        #expect(session.cancelOutput())
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "clear",
                "talkEvent": ["turnId": "turn-a"],
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-b"))
        await session._test_handleGatewayEvent(
            outputAudioEvent(turnId: "turn-a", data: Data(repeating: 1, count: 961)))
        #expect(issues.isEmpty)
        #expect(terminations.isEmpty)

        await session._test_handleGatewayEvent(
            outputAudioEvent(turnId: "turn-b", data: Data(repeating: 1, count: 961)))
        #expect(issues.map(\.phase) == ["output-playback"])
        #expect(terminations == [.outputPlaybackOverflow])
    }

    @Test func `exact maximum output audio frame is accepted`() async {
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: StalledPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(
            outputAudioEvent(turnId: "turn-1", data: Data(repeating: 1, count: 960)))

        #expect(issues.isEmpty)
        #expect(terminations.isEmpty)
        #expect(session._test_isOutputPlaying())
        session.stop()
    }

    @Test func `active output pause cancels the exact turn`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x01]).base64EncodedString(),
                "talkEvent": ["turnId": "turn-7"],
            ]),
            seq: nil,
            stateversion: nil))

        session.setOutputPaused(true)
        for _ in 0..<10 {
            if await !requests.snapshot().isEmpty { break }
            await Task.yield()
        }
        let request = try #require(await requests.snapshot().first)
        #expect(request.params?["turnId"]?.stringValue == "turn-7")
        #expect(request.params?["reason"]?.stringValue == "pause")
    }

    @Test func `current cancellation failure terminates and rejects late audio`() async {
        let requests = RealtimeRelayStartupRequestLog()
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        var speakingStates: [Bool] = []
        let cancellationError = URLError(.cannotConnectToHost)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.cancelOutput" {
                    throw cancellationError
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))

        session.cancelOutput()
        for _ in 0..<50 {
            if !issues.isEmpty { break }
            await Task.yield()
        }
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-2"))
        for _ in 0..<50 {
            if await requests.snapshot().contains(where: { $0.method == "talk.session.close" }) { break }
            await Task.yield()
        }

        #expect(issues.map(\.code) == ["realtime_output_cancel_failed"])
        #expect(issues.map(\.phase) == ["output-cancel"])
        #expect(issues.first?.message == String(
            format: String(localized: "Realtime output cancellation failed: %@"),
            cancellationError.localizedDescription))
        #expect(terminations == [.outputCancellationFailed])
        #expect(await requests.snapshot().map(\.method) == [
            "talk.session.cancelOutput",
            "talk.session.close",
        ])
        #expect(speakingStates.first == true)
        #expect(!speakingStates.dropFirst().contains(true))
    }

    @Test func `superseded cancellation failure leaves the active fence intact`() async {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var issues: [RealtimeTalkRelayIssue] = []
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if await requests.snapshot().count == 1 {
                    await barrier.suspend()
                    throw URLError(.cancelled)
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))

        #expect(session.cancelOutput())
        await barrier.waitUntilEntered()
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "clear",
                "talkEvent": ["turnId": "turn-1"],
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-2"))
        #expect(session.cancelOutput())
        await barrier.release()
        await session._test_waitForOutputCancellation()
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))

        #expect(issues.isEmpty)
        #expect(await requests.snapshot().count == 2)
        #expect(speakingStates == [true, false, true, false])
    }

    @Test func `clear keeps microphone fenced until cancellation response`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    if method == "talk.session.cancelOutput" {
                        await barrier.suspend()
                        return Data("{\"status\":\"applied\",\"turnId\":\"turn-1\"}".utf8)
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        #expect(session.cancelOutput())
        await barrier.waitUntilEntered()
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "clear",
                "talkEvent": ["turnId": "turn-1"],
            ]),
            seq: nil,
            stateversion: nil))

        #expect(session._test_enqueueMicrophoneFrame(Data([0x01])) == nil)
        await barrier.release()
        await session._test_waitForOutputCancellation()
        let admittedTask = try #require(session._test_enqueueMicrophoneFrame(Data([0x02])))
        await admittedTask.value
        #expect(await requests.snapshot().map(\.method) == [
            "talk.session.cancelOutput",
            "talk.session.appendAudio",
        ])
    }

    @Test func `close retires in flight cancellation failure`() async {
        let barrier = RealtimeRelayStartupBarrier()
        var issues: [RealtimeTalkRelayIssue] = []
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, _, _ in
                    if method == "talk.session.cancelOutput" {
                        await barrier.suspend()
                        throw URLError(.cancelled)
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        #expect(session.cancelOutput())
        await barrier.waitUntilEntered()
        session.stop()
        await barrier.release()
        await Task.yield()

        #expect(issues.isEmpty)
    }

    @Test func `close after classified error does not replace issue`() async {
        var issues: [RealtimeTalkRelayIssue] = []
        var statuses: [String] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "error",
                "message": "OpenAI API key rejected with 401",
                "code": "realtime_unavailable",
                "provider": "openai",
                "model": "gpt-realtime-2",
                "transport": "gateway-relay",
                "phase": "connect",
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "close",
                "reason": "error",
            ]),
            seq: nil,
            stateversion: nil))

        #expect(issues.map(\.code) == ["realtime_unavailable"])
        #expect(statuses == ["OpenAI API key rejected with 401"])
    }

    @Test func `pre-ready relay failure throws and closes created session`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let failureEvent = EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "error",
                "message": "OpenAI API key rejected with 401",
                "phase": "connect",
            ]),
            seq: nil,
            stateversion: nil)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in
                AsyncStream { continuation in
                    continuation.yield(failureEvent)
                }
            },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.create" {
                    return resultData
                }
                return Data("{\"ok\":true}".utf8)
            })
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        do {
            try await session.start()
            Issue.record("Expected the pre-ready relay failure to throw")
        } catch {
            #expect(error.localizedDescription == "OpenAI API key rejected with 401")
        }

        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
        #expect(!audioCapture.isStarted)
    }

    @Test func `pre-ready event stream end promptly fails startup and closes created session once`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let eventChannel = AsyncStream<EventFrame>.makeStream()
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in eventChannel.stream },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.create" {
                    return resultData
                }
                return Data("{\"ok\":true}".utf8)
            })
        let audioCapture = TestRealtimeTalkAudioCapture()
        var issues: [RealtimeTalkRelayIssue] = []
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        let start = Task { @MainActor in try await session.start() }
        while !audioCapture.isStarted {
            await Task.yield()
        }

        let disconnectedAt = ContinuousClock.now
        eventChannel.continuation.finish()
        do {
            try await start.value
            Issue.record("Expected the pre-ready event stream end to throw")
        } catch {
            #expect(error.localizedDescription == "Realtime connection ended before it became ready.")
        }

        #expect(disconnectedAt.duration(to: .now) < .seconds(1))
        #expect(issues.map(\.phase) == ["connect"])
        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
        #expect(!audioCapture.isStarted)
    }

    @Test func `event stream ending during relay creation closes the late relay`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let events = RealtimeRelayEventSource()
        let requests = RealtimeRelayStartupRequestLog()
        let audioCapture = TestRealtimeTalkAudioCapture()
        var issues: [RealtimeTalkRelayIssue] = []
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in await events.stream() },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    if method == "talk.session.create" {
                        await barrier.suspend()
                        return resultData
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        let start = Task { @MainActor in
            do {
                try await session.start()
                return nil as String?
            } catch {
                return error.localizedDescription
            }
        }
        await barrier.waitUntilEntered()

        await events.finish()
        while issues.isEmpty {
            await Task.yield()
        }
        await barrier.release()

        #expect(await start.value == "Realtime connection ended before it became ready.")
        #expect(audioCapture.startCount == 0)
        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
    }

    @Test func `microphone failure terminates relay and reports typed issue`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { _ in } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let audioCapture = TestRealtimeTalkAudioCapture()
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        try session._test_startMicrophonePump()

        audioCapture.fail("Realtime microphone became unavailable: no input")
        for _ in 0..<10 {
            if await !(requests.snapshot()).isEmpty { break }
            await Task.yield()
        }

        #expect(issues.map(\.code) == ["audio_input_unavailable"])
        #expect(issues.map(\.phase) == ["audio-input"])
        #expect(terminations == [.audioInputFailed(
            message: "Realtime microphone became unavailable: no input")])
        #expect(!audioCapture.isStarted)
        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.close"])
        #expect(recorded.first?.params?["sessionId"]?.stringValue == "relay-1")
    }

    @Test func `ready then close publishes one typed termination and releases capture`() async {
        var statuses: [String] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "ready",
            ]),
            seq: nil,
            stateversion: nil))
        let closeEvent = EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "close",
                "reason": "completed",
            ]),
            seq: nil,
            stateversion: nil)
        await session._test_handleGatewayEvent(closeEvent)
        await session._test_handleGatewayEvent(closeEvent)

        #expect(statuses == ["Listening (Realtime)", "Ready"])
        #expect(terminations == [.remoteClose(reason: "completed")])
        #expect(audioCapture.stopCount == 1)
    }

    @Test func `ready then event stream end publishes typed termination`() async {
        var terminations: [RealtimeTalkRelayTermination] = []
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "ready",
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleEventStreamEnded()
        await session._test_handleEventStreamEnded()

        #expect(terminations == [.eventStreamEnded])
        #expect(audioCapture.stopCount == 1)
    }

    @Test func `closed relay does not wait for startup ready`() async {
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        session.stop()

        #expect(await session._test_waitForStartupCancelled(timeoutSeconds: 1))
    }

    @Test func `startup ready wait covers gateway connect budget`() {
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        #expect(session._test_startupReadyTimeoutSeconds() >= 12)
    }

    @Test func `stop during event subscription prevents relay creation`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in
                await barrier.suspend()
                return AsyncStream { $0.finish() }
            },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                throw URLError(.badServerResponse)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        let start = Task { @MainActor in try await session.start() }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        try await start.value

        #expect(await requests.snapshot().isEmpty)
        #expect(statuses == ["Connecting realtime…"])
        #expect(!speakingStates.contains(true))
    }

    @Test func `stop during relay creation closes late session once`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        var speakingStates: [Bool] = []
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.create" {
                    await barrier.suspend()
                    return resultData
                }
                return Data("{}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        let start = Task { @MainActor in try await session.start() }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        try await start.value

        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
        #expect(!statuses.contains("Waiting for realtime…"))
        #expect(!speakingStates.contains(true))
    }

    @Test func `stop during buffered tool call prevents late relay side effects`() async {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.client.toolCall" {
                    await barrier.suspend()
                    return Data("{\"runId\":\"run-1\"}".utf8)
                }
                return Data("{}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        let handling = Task { @MainActor in
            await session._test_handleGatewayEvent(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "toolCall",
                    "callId": "call-1",
                    "name": "lookup",
                    "args": [:],
                ]),
                seq: nil,
                stateversion: nil))
        }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        await handling.value
        await session._test_waitForToolCalls()

        let methods = await requests.snapshot().map(\.method)
        #expect(methods.first == "talk.client.toolCall")
        #expect(!methods.contains("talk.session.submitToolResult"))
        #expect(statuses == ["Thinking…"])
    }

    @Test func `stop and pause retire buffered audio while resume admits a fresh frame`() async throws {
        let stoppedRequests = ControlledRealtimeAudioRequests()
        var stoppedStatuses: [String] = []
        var stoppedIssues: [RealtimeTalkRelayIssue] = []
        var stoppedTerminations: [RealtimeTalkRelayTermination] = []
        let stoppedSession = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, _, _ in try await stoppedRequests.request(method: method) }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { stoppedStatuses.append($0) },
            onIssue: { stoppedIssues.append($0) },
            onTermination: { stoppedTerminations.append($0) },
            onSpeakingChanged: { _ in })
        stoppedSession._test_setRelaySessionId("relay-1")
        stoppedSession._test_prepareAudioSender(relaySessionId: "relay-1")
        let stoppedSend = try #require(stoppedSession._test_enqueueMicrophoneFrame(Data([0x01])))
        do {
            try await stoppedRequests.waitForRequestCount(1)
            stoppedSession.stop()
            try await stoppedRequests.waitForRequestCount(2)
        } catch {
            stoppedSession.stop()
            await stoppedRequests.succeedPendingAppends()
            await stoppedSend.value
            throw error
        }
        await stoppedRequests.succeedPendingAppends()
        await stoppedRequests.succeedPendingAppends()
        await stoppedSend.value
        #expect(await stoppedRequests.snapshot() == [
            "talk.session.appendAudio",
            "talk.session.close",
        ])
        #expect(stoppedStatuses.isEmpty)
        #expect(stoppedIssues.isEmpty)
        #expect(stoppedTerminations.isEmpty)

        let requests = ControlledRealtimeAudioRequests()
        var statuses: [String] = []
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, _, _ in try await requests.request(method: method) }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onIssue: { issues.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        let pausedSend = try #require(session._test_enqueueMicrophoneFrame(Data([0x01])))
        var resumedSend: Task<Void, Never>?
        do {
            try await requests.waitForRequestCount(1)
            try session.setInputPaused(true)
            #expect(await requests.snapshot() == ["talk.session.appendAudio"])
            try session.setInputPaused(false)
            guard let freshSend = session._test_enqueueMicrophoneFrame(Data([0x02])) else {
                throw RealtimeRelayTestTimeout(operation: "resumed microphone frame admission")
            }
            resumedSend = freshSend
            try await requests.waitForRequestCount(2)
        } catch {
            session.stop()
            await requests.succeedPendingAppends()
            await pausedSend.value
            await resumedSend?.value
            throw error
        }
        await requests.succeedPendingAppends()
        await requests.succeedPendingAppends()
        await pausedSend.value
        await resumedSend?.value
        #expect(await requests.snapshot() == [
            "talk.session.appendAudio",
            "talk.session.appendAudio",
        ])
        session.stop()
        try await requests.waitForRequestCount(3)
        #expect(await requests.snapshot() == [
            "talk.session.appendAudio",
            "talk.session.appendAudio",
            "talk.session.close",
        ])
        #expect(statuses.isEmpty)
        #expect(issues.isEmpty)
        #expect(terminations.isEmpty)
    }

    @Test func `gateway route lost during startup fails instead of reporting ready`() async throws {
        let route = RealtimeRelayRouteFlag()
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in
                    // The Gateway replaces the route immediately after the subscription lands.
                    await route.expire()
                    return AsyncStream { $0.finish() }
                },
                request: { _, _, _ in Data("{\"ok\":true}".utf8) },
                isCurrent: { await route.value() }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        do {
            try await session.start()
            Issue.record("Expected a lost Gateway route to fail startup")
        } catch is CancellationError {
            // The runtime returns silently on CancellationError, so classifying route loss as
            // cancellation would leave Talk marked listening with no relay and no fallback.
            Issue.record("Route loss must not surface as local cancellation")
        } catch {
            #expect(
                error.localizedDescription ==
                    "Gateway connection was replaced before realtime startup finished")
        }

        #expect(!audioCapture.isStarted)
    }

    @Test func `appended audio timestamps stay whole milliseconds`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_prepareAudioSender(relaySessionId: "relay-1")

        // macOS taps stamp frames with `systemUptime * 1000`, so the raw value is fractional.
        let send = try #require(
            session._test_enqueueMicrophoneFrame(Data([0x01, 0x02]), timestampMs: 4823.617))
        await send.value

        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.appendAudio"])
        // A decimal reaches the provider as a non-integer `audio_end_ms` and its
        // `conversation.item.truncate` is rejected, ending the session on the first barge-in.
        let timestamp = try #require(recorded.first?.params?["timestamp"]?.value as? Double)
        #expect(timestamp == 4824)
        #expect(timestamp == timestamp.rounded())
    }

    @Test func `microphone saturation terminates once without sending the fifth frame`() async throws {
        let requests = ControlledRealtimeAudioRequests()
        let audioCapture = TestRealtimeTalkAudioCapture()
        var statuses: [String] = []
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let terminationObserved = RealtimeRelayTestSignal<RealtimeTalkRelayTermination>()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, _, _ in try await requests.request(method: method) }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onIssue: { issues.append($0) },
            onTermination: {
                terminations.append($0)
                terminationObserved.send($0)
            },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        try session._test_startMicrophonePump()
        let stopCountBeforeFailure = audioCapture.stopCount

        var pending: [Task<Void, Never>] = []
        var saturated: Task<Void, Never>?
        do {
            for index in 0..<4 {
                guard let send = session._test_enqueueMicrophoneFrame(Data([UInt8(index)])) else {
                    throw RealtimeRelayTestTimeout(operation: "microphone frame \(index) admission")
                }
                pending.append(send)
            }
            try await requests.waitForRequestCount(4)
            guard let saturationSend = session._test_enqueueMicrophoneFrame(Data([0xFF])) else {
                throw RealtimeRelayTestTimeout(operation: "saturation frame admission")
            }
            saturated = saturationSend
            _ = try await terminationObserved.next("microphone saturation termination")
            await saturated?.value
            try await requests.waitForRequestCount(5)
        } catch {
            saturated?.cancel()
            pending.forEach { $0.cancel() }
            session.stop()
            await requests.succeedPendingAppends()
            await saturated?.value
            for task in pending {
                await task.value
            }
            throw error
        }

        let message = String(localized: "Realtime audio input fell behind. Reconnecting…")
        #expect(await requests.snapshot() == [
            "talk.session.appendAudio",
            "talk.session.appendAudio",
            "talk.session.appendAudio",
            "talk.session.appendAudio",
            "talk.session.close",
        ])
        #expect(statuses == [message])
        #expect(issues.map(\.code) == ["audio_input_unavailable"])
        #expect(issues.map(\.message) == [message])
        #expect(terminations == [.audioInputFailed(message: message)])
        #expect(audioCapture.stopCount == stopCountBeforeFailure + 1)

        await requests.succeedPendingAppends()
        await requests.succeedPendingAppends()
        for task in pending {
            await task.value
        }
        #expect(statuses == [message])
        #expect(issues.count == 1)
        #expect(terminations.count == 1)
        #expect(await requests.snapshot().filter { $0 == "talk.session.close" }.count == 1)
    }

    @Test func `active audio request and response failures share the input failure owner`() async throws {
        for behavior in [ControlledAudioAppendBehavior.requestFailure, .malformedResponse] {
            let requests = ControlledRealtimeAudioRequests(behavior: behavior)
            let audioCapture = TestRealtimeTalkAudioCapture()
            var statuses: [String] = []
            var issues: [RealtimeTalkRelayIssue] = []
            var terminations: [RealtimeTalkRelayTermination] = []
            let session = RealtimeTalkRelaySession(
                transport: RealtimeTalkRelayTransport(
                    subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                    request: { method, _, _ in try await requests.request(method: method) }),
                options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
                audioCapture: audioCapture,
                pcmPlayer: UnusedPCMStreamingAudioPlayer(),
                onStatus: { statuses.append($0) },
                onIssue: { issues.append($0) },
                onTermination: { terminations.append($0) },
                onSpeakingChanged: { _ in })
            session._test_setRelaySessionId("relay-1")
            session._test_prepareAudioSender(relaySessionId: "relay-1")
            try session._test_startMicrophonePump()
            let stopCountBeforeFailure = audioCapture.stopCount

            let send = try #require(session._test_enqueueMicrophoneFrame(Data([0x01])))
            await send.value
            try await requests.waitForRequestCount(2)

            let issue = try #require(issues.first)
            #expect(issue.code == "audio_input_unavailable")
            #expect(issue.phase == "audio-input")
            #expect(statuses == [issue.message])
            #expect(terminations == [.audioInputFailed(message: issue.message)])
            #expect(audioCapture.stopCount == stopCountBeforeFailure + 1)
            #expect(await requests.snapshot() == [
                "talk.session.appendAudio",
                "talk.session.close",
            ])
        }
    }

}
