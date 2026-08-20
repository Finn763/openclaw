import Foundation
import OpenClawChatUI
import OpenClawKit
import OSLog

extension TalkModeRuntime {
    private enum ScheduledRealtimeRecoveryState: Equatable {
        case cancelled
        case waitingForStartToFinish
        case ready
    }

    private static let realtimeStableSessionSeconds: TimeInterval = 30
    private static let realtimeRestartDelaysNanoseconds: [UInt64] = [500_000_000, 2_000_000_000]

    static func realtimeRestartAttempt(
        previousRapidRestarts: Int,
        activeDuration: TimeInterval) -> Int
    {
        activeDuration >= self.realtimeStableSessionSeconds ? 1 : previousRapidRestarts + 1
    }

    static func realtimeRestartDelayNanoseconds(attempt: Int) -> UInt64? {
        guard attempt > 0, attempt <= self.realtimeRestartDelaysNanoseconds.count else { return nil }
        return self.realtimeRestartDelaysNanoseconds[attempt - 1]
    }

    func startRealtimeRelay(generation: Int) async throws {
        let relayGeneration = try self.beginRealtimeRelayStart()
        defer {
            if self.realtimeRelayStartGeneration == relayGeneration {
                self.realtimeRelayStartGeneration = nil
            }
        }
        let session = try await self.makeRealtimeRelaySession(
            lifecycleGeneration: generation,
            relayGeneration: relayGeneration)
        try await self.ownAndStartRealtimeSession(
            session,
            lifecycleGeneration: generation,
            relayGeneration: relayGeneration,
            start: { session in try await session.start() })
        self.realtimeSessionReadyAt = Date()
        self.phase = .listening
        _ = await self.projectRealtimeRelay(relayGeneration, session) {
            TalkModeController.shared.updatePartialTranscript("")
            TalkModeController.shared.updatePhase(.listening)
        }
        self.logger.info(
            "talk realtime ready provider=\(self.realtimeProvider ?? "default", privacy: .public) " +
                "model=\(self.realtimeModelId ?? "default", privacy: .public)")
    }

    private func beginRealtimeRelayStart() throws -> UInt64 {
        guard self.realtimeSession == nil, self.realtimeRelayStartGeneration == nil else {
            throw CancellationError()
        }
        self.realtimeRelayGeneration &+= 1
        let relayGeneration = self.realtimeRelayGeneration
        self.realtimeRelayStartGeneration = relayGeneration
        return relayGeneration
    }

    private func makeRealtimeRelaySession(
        lifecycleGeneration: Int,
        relayGeneration: UInt64) async throws -> RealtimeTalkRelaySession
    {
        let transport = try await GatewayConnection.shared.acquireRealtimeTalkTransport()
        guard self.isCurrent(lifecycleGeneration), !self.isPaused,
              self.realtimeRelayGeneration == relayGeneration
        else { throw CancellationError() }
        let activeSessionKey = await MainActor.run {
            WebChatManager.shared.activeSessionKey
        }
        let sessionKey: String = if let activeSessionKey {
            activeSessionKey
        } else {
            await GatewayConnection.shared.mainSessionKey()
        }
        let options = RealtimeTalkRelaySession.Options(
            sessionKey: sessionKey,
            provider: self.realtimeProvider,
            model: self.realtimeModelId,
            voice: self.realtimeSpeakerVoice)
        return await MainActor.run {
            RealtimeTalkRelaySession(
                transport: transport,
                options: options,
                audioCapture: MacRealtimeTalkAudioCapture(),
                pcmPlayer: RealtimePCMStreamingAudioPlayer(),
                onStatus: { [weak self] status in
                    Task { await self?.handleRealtimeStatus(status, relayGeneration: relayGeneration) }
                },
                onIssue: { [weak self] issue in
                    Task { await self?.handleRealtimeIssue(issue, relayGeneration: relayGeneration) }
                },
                onTermination: { [weak self] termination in
                    Task {
                        await self?.handleRealtimeTermination(
                            termination,
                            relayGeneration: relayGeneration)
                    }
                },
                onSpeakingChanged: { [weak self] speaking in
                    Task {
                        await self?.handleRealtimeSpeakingChanged(
                            speaking,
                            relayGeneration: relayGeneration)
                    }
                },
                onInputLevel: { [weak self] level in
                    Task { await self?.handleRealtimeInputLevel(level, relayGeneration: relayGeneration) }
                },
                onOutputLevel: { [weak self] level in
                    Task { await self?.handleRealtimeOutputLevel(level, relayGeneration: relayGeneration) }
                },
                onTranscript: { [weak self] transcript in
                    Task {
                        await self?.handleRealtimeTranscript(
                            transcript,
                            relayGeneration: relayGeneration)
                    }
                })
        }
    }

    private func ownAndStartRealtimeSession(
        _ session: RealtimeTalkRelaySession,
        lifecycleGeneration: Int,
        relayGeneration: UInt64,
        start: @MainActor @Sendable (RealtimeTalkRelaySession) async throws -> Void) async throws
    {
        // Construction crosses executors. Claim ownership only after every lifecycle and
        // attempt fact is revalidated, then publish before start can suspend.
        guard self.isCurrent(lifecycleGeneration), !self.isPaused,
              self.realtimeRelayGeneration == relayGeneration,
              self.realtimeRelayStartGeneration == relayGeneration,
              self.realtimeSession == nil
        else {
            await MainActor.run { session.stop() }
            throw CancellationError()
        }
        self.realtimeSession = session
        do {
            try await start(session)
        } catch {
            await MainActor.run { session.stop() }
            if self.realtimeSession === session {
                self.realtimeSession = nil
            }
            guard self.isCurrent(lifecycleGeneration), !self.isPaused,
                  self.realtimeRelayGeneration == relayGeneration,
                  self.realtimeRelayStartGeneration == relayGeneration
            else {
                throw CancellationError()
            }
            throw error
        }
        guard self.isCurrent(lifecycleGeneration), !self.isPaused,
              self.realtimeRelayGeneration == relayGeneration,
              self.realtimeSession === session
        else {
            await MainActor.run { session.stop() }
            if self.realtimeSession === session {
                self.realtimeSession = nil
            }
            throw CancellationError()
        }
    }

    private func handleRealtimeStatus(_ status: String, relayGeneration: UInt64) {
        guard let session = self.realtimeSession,
              self.ownsRealtimeRelay(relayGeneration, session)
        else { return }
        self.logger.debug("talk realtime status=\(status, privacy: .public)")
    }

    private func handleRealtimeIssue(_ issue: RealtimeTalkRelayIssue, relayGeneration: UInt64) async {
        guard let session = self.realtimeSession,
              self.ownsRealtimeRelay(relayGeneration, session)
        else { return }
        self.logger.error(
            "talk realtime issue code=\(issue.code, privacy: .public) " +
                "message=\(issue.message, privacy: .public)")
        _ = await self.projectRealtimeRelay(relayGeneration, session) { TalkModeController.shared
            .updatePartialTranscript(issue.message)
        }
    }

    func handleRealtimeInputRestartFailure(
        _ message: String,
        relayGeneration: UInt64) async
    {
        let issue = RealtimeTalkRelayIssue(
            code: "audio_input_unavailable",
            message: message,
            provider: self.realtimeProvider,
            model: self.realtimeModelId,
            transport: "gateway-relay",
            phase: "audio-input")
        await self.handleRealtimeIssue(issue, relayGeneration: relayGeneration)
        await self.handleRealtimeTermination(
            .audioCaptureFailed(message: issue.message),
            relayGeneration: relayGeneration)
    }

    func setRealtimeInputPaused(
        _ paused: Bool,
        session: RealtimeTalkRelaySession,
        relayGeneration: UInt64) async -> Bool
    {
        do {
            try await MainActor.run {
                try session.setInputPaused(paused)
            }
            return true
        } catch {
            self.logger.error(
                "talk realtime pause transition failed: \(error.localizedDescription, privacy: .public)")
            await self.handleRealtimeInputRestartFailure(
                error.localizedDescription,
                relayGeneration: relayGeneration)
            return false
        }
    }

    func handleRealtimeTermination(
        _ termination: RealtimeTalkRelayTermination,
        relayGeneration: UInt64) async
    {
        guard let session = self.realtimeSession,
              self.ownsRealtimeRelay(relayGeneration, session)
        else { return }
        self.logger.warning(
            "talk realtime terminated=\(String(describing: termination), privacy: .public)")
        let activeDuration = self.realtimeSessionReadyAt.map { Date().timeIntervalSince($0) } ?? 0
        self.realtimeRelayGeneration &+= 1
        let terminalGeneration = self.realtimeRelayGeneration
        // Session-owned terminations close before signalling; runtime-initiated ones do not.
        // stop() is idempotent, so closing here keeps a dead relay and its event subscription
        // from outliving their owner while recovery starts a replacement session.
        await MainActor.run { session.stop() }
        guard self.ownsRealtimeRelay(terminalGeneration, session) else { return }
        self.realtimeSession = nil
        self.realtimeSessionReadyAt = nil
        self.phase = .idle
        let shouldRecover = self.isEnabled && !self.isPaused
        let attempt = Self.realtimeRestartAttempt(
            previousRapidRestarts: self.rapidRealtimeRestartCount,
            activeDuration: activeDuration)
        let delay = Self.realtimeRestartDelayNanoseconds(attempt: attempt)
        guard await self.projectRealtimeRelay(terminalGeneration, nil, {
            TalkModeController.shared.updateLevel(0)
            TalkModeController.shared.updateSpeakingLevel(nil)
            TalkModeController.shared.updatePhase(.idle)
            if shouldRecover {
                TalkModeController.shared.updatePartialTranscript(delay == nil
                    ? String(localized: "Realtime disconnected repeatedly — using native speech")
                    : String(localized: "Realtime disconnected — reconnecting…"))
            }
        }) else { return }
        let lifecycleGeneration = self.lifecycleGeneration
        let restartGeneration = self.realtimeRestartGeneration &+ 1
        guard shouldRecover, self.ownsRealtimeRelay(terminalGeneration, nil),
              self.isEnabled, !self.isPaused
        else { return }
        self.rapidRealtimeRestartCount = attempt
        self.realtimeRestartGeneration = restartGeneration
        self.bypassRealtimeOnNextStart = delay == nil
        self.scheduleRealtimeRecovery(
            after: delay,
            lifecycleGeneration: lifecycleGeneration,
            restartGeneration: restartGeneration)
    }

    func handleRealtimeSpeakingChanged(_ speaking: Bool, relayGeneration: UInt64) async {
        guard let session = self.realtimeSession,
              self.ownsRealtimeRelay(relayGeneration, session),
              self.isEnabled,
              !self.isPaused
        else { return }
        if speaking {
            self.phase = .speaking
            _ = await self.projectRealtimeRelay(relayGeneration, session) {
                TalkModeController.shared.updatePhase(.speaking)
            }
        } else if !self.isPaused {
            self.phase = .listening
            _ = await self.projectRealtimeRelay(relayGeneration, session) {
                TalkModeController.shared.updatePhase(.listening)
            }
        }
    }

    func handleRealtimeInputLevel(_ level: Double, relayGeneration: UInt64) async {
        guard let session = self.realtimeSession,
              self.ownsRealtimeRelay(relayGeneration, session),
              self.isEnabled,
              !self.isPaused
        else { return }
        _ = await self.projectRealtimeRelay(relayGeneration, session) {
            TalkModeController.shared.updateLevel(level)
        }
    }

    func handleRealtimeOutputLevel(_ level: Double?, relayGeneration: UInt64) async {
        guard let session = self.realtimeSession,
              self.ownsRealtimeRelay(relayGeneration, session),
              self.isEnabled,
              !self.isPaused
        else { return }
        _ = await self.projectRealtimeRelay(relayGeneration, session) {
            TalkModeController.shared.updateSpeakingLevel(level)
        }
    }

    func handleRealtimeTranscript(
        _ transcript: RealtimeTalkTranscript,
        relayGeneration: UInt64) async
    {
        guard let session = self.realtimeSession,
              self.ownsRealtimeRelay(relayGeneration, session),
              self.isEnabled,
              !self.isPaused
        else { return }
        let text = transcript.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard transcript.role == "user" else { return }
        if transcript.isFinal {
            self.phase = .thinking
            _ = await self.projectRealtimeRelay(relayGeneration, session) {
                TalkModeController.shared.commitTranscript(text)
                TalkModeController.shared.updatePhase(.thinking)
            }
        } else {
            _ = await self.projectRealtimeRelay(relayGeneration, session) {
                TalkModeController.shared.updatePartialTranscript(text)
            }
        }
    }

    func ownsRealtimeRelay(_ generation: UInt64, _ session: RealtimeTalkRelaySession?) -> Bool {
        self.realtimeRelayGeneration == generation && self.realtimeSession === session
    }

    func projectRealtimeRelay(
        _ generation: UInt64,
        _ session: RealtimeTalkRelaySession?,
        _ body: @escaping @MainActor @Sendable () -> Void) async -> Bool
    {
        guard self.ownsRealtimeRelay(generation, session) else { return false }
        return await MainActor.run {
            self.realtimeRelayDeliveryGate.deliver(ifActive: generation, body)
        }
    }

    func resetRealtimeRecoveryState() {
        self.cancelScheduledRealtimeRecovery()
        self.realtimeSessionReadyAt = nil
        self.rapidRealtimeRestartCount = 0
        self.bypassRealtimeOnNextStart = false
    }

    func cancelScheduledRealtimeRecovery() {
        self.realtimeRestartGeneration &+= 1
        self.realtimeRestartTask?.cancel()
        self.realtimeRestartTask = nil
    }

    private func scheduleRealtimeRecovery(
        after delayNanoseconds: UInt64?,
        lifecycleGeneration: Int,
        restartGeneration: UInt64)
    {
        self.realtimeRestartTask?.cancel()
        self.realtimeRestartTask = Task { [weak self] in
            if let delayNanoseconds {
                do {
                    try await Task.sleep(nanoseconds: delayNanoseconds)
                } catch {
                    return
                }
            }
            while let self {
                switch await self.scheduledRealtimeRecoveryState(
                    lifecycleGeneration: lifecycleGeneration,
                    restartGeneration: restartGeneration)
                {
                case .cancelled:
                    return
                case .waitingForStartToFinish:
                    do {
                        try await Task.sleep(nanoseconds: 50_000_000)
                    } catch {
                        return
                    }
                case .ready:
                    await self.performScheduledRealtimeRecovery(
                        lifecycleGeneration: lifecycleGeneration,
                        restartGeneration: restartGeneration)
                    return
                }
            }
        }
    }

    private func scheduledRealtimeRecoveryState(
        lifecycleGeneration: Int,
        restartGeneration: UInt64) -> ScheduledRealtimeRecoveryState
    {
        guard self.lifecycleGeneration == lifecycleGeneration,
              self.realtimeRestartGeneration == restartGeneration,
              self.isEnabled,
              !self.isPaused,
              self.realtimeSession == nil
        else { return .cancelled }
        return self.realtimeRelayStartGeneration == nil ? .ready : .waitingForStartToFinish
    }

    private func performScheduledRealtimeRecovery(
        lifecycleGeneration: Int,
        restartGeneration: UInt64) async
    {
        guard self.scheduledRealtimeRecoveryState(
            lifecycleGeneration: lifecycleGeneration,
            restartGeneration: restartGeneration) == .ready
        else { return }
        self.realtimeRestartTask = nil
        await self.start()
    }
}

#if DEBUG
extension TalkModeRuntime {
    func _test_prepareEnabledLifecycle() -> Int {
        self.isEnabled = true
        self.isPaused = false
        self.lifecycleGeneration &+= 1
        return self.lifecycleGeneration
    }

    func _test_startRealtimeRelay(
        lifecycleGeneration: Int,
        makeSession: @escaping @Sendable () async -> RealtimeTalkRelaySession,
        start: @escaping @MainActor @Sendable (RealtimeTalkRelaySession) async throws -> Void) async throws
    {
        let relayGeneration = try self.beginRealtimeRelayStart()
        defer {
            if self.realtimeRelayStartGeneration == relayGeneration {
                self.realtimeRelayStartGeneration = nil
            }
        }
        let session = await makeSession()
        try await self.ownAndStartRealtimeSession(
            session,
            lifecycleGeneration: lifecycleGeneration,
            relayGeneration: relayGeneration,
            start: start)
    }

    func _test_prepareEnabledRealtimeSessionForClose(
        _ session: RealtimeTalkRelaySession) -> UInt64
    {
        self.cancelScheduledRealtimeRecovery()
        self.isEnabled = true
        self.isPaused = false
        self.lifecycleGeneration &+= 1
        self.realtimeRelayGeneration &+= 1
        self.realtimeSession = session
        self.realtimeSessionReadyAt = nil
        self.rapidRealtimeRestartCount = 0
        self.bypassRealtimeOnNextStart = false
        return self.realtimeRelayGeneration
    }
}
#endif
