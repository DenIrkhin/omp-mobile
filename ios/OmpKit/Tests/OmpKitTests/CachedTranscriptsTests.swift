import Testing
@testable import OmpKit

@Suite struct CachedTranscriptsTests {
    let host = "mac.alpha.ts.net"

    @Test func matchesTheServerAndItsDomain() {
        #expect(CachedTranscripts.isServerRecord("mac.alpha.ts.net", serverHost: host))
        #expect(CachedTranscripts.isServerRecord("alpha.ts.net", serverHost: host))
        #expect(CachedTranscripts.isServerRecord("Alpha.TS.net", serverHost: host))
    }

    @Test func leavesOtherSitesAlone() {
        #expect(!CachedTranscripts.isServerRecord("my.omp.sh", serverHost: host))
        #expect(!CachedTranscripts.isServerRecord("bravo.ts.net", serverHost: host))
        #expect(!CachedTranscripts.isServerRecord("pha.ts.net", serverHost: host))
        #expect(!CachedTranscripts.isServerRecord("", serverHost: host))
    }
}
