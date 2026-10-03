// SHARD — /terms: Terms of Service & legal disclaimer. A plain-language
// legal page in the same strict monochrome system as /security: no stock
// photos, no promises the code cannot keep, honest about the AS-IS state.
import DocShell, { DocSection } from "../components/DocShell";

export default function Terms() {
  return (
    <DocShell
      eyebrow="Legal"
      title="Terms of Service"
      subtitle="Plain-language terms for using SHARD. By opening a session you agree to what follows."
    >
      {/* ---- 1. Acceptance of terms ---- */}
      <DocSection title="1 · Acceptance of Terms">
        <p>
          SHARD is free, open-source software distributed under the{" "}
          <strong className="font-medium text-heading">GNU Affero General Public License v3.0
          (AGPL-3.0)</strong>. The source code of both the relay and the client is publicly
          available for inspection, modification and self-hosting under that license.
        </p>
        <p>
          By accessing or using this deployment of SHARD — creating a session, joining one, or
          transferring files through it — you accept these terms. If you do not accept them,
          do not use the service. Self-hosted deployments may apply their own terms; this
          document covers the hosted instance only.
        </p>
        <p>
          The service is provided as-is, without accounts, registration or identity checks.
          You are responsible for the lawful use of your own devices and network connection.
        </p>
      </DocSection>

      {/* ---- 2. Permitted & prohibited use ---- */}
      <DocSection title="2 · Permitted & Prohibited Use">
        <p>
          SHARD exists for one purpose:{" "}
          <strong className="font-medium text-heading">
            confidential, lawful communication between two people
          </strong>{" "}
          — conversations, documents and calls that belong to the participants alone.
        </p>
        <p>
          Using the service to distribute malware, to traffic illegal material, to threaten or
          harass people, or to coordinate attacks against systems or persons is strictly
          prohibited. Sessions found to be used for such purposes may be terminated without
          notice and such usage reported where the law requires.
        </p>
        <p>
          Because rooms are end-to-end encrypted and burned after close, operators cannot
          moderate content in transit; enforcement relies on the technical limits described in
          the security architecture (executable blocking, size caps) and on applicable law.
        </p>
      </DocSection>

      {/* ---- 3. Zero-knowledge disclaimer ---- */}
      <DocSection title="3 · Zero-Knowledge Disclaimer">
        <p>
          Session keys are derived on your device and never transmitted. The relay operator{" "}
          <strong className="font-medium text-heading">
            holds no encryption keys and possesses no technical ability
          </strong>{" "}
          to read, decrypt, filter or reconstruct user traffic — neither live nor after a
          session has burned.
        </p>
        <p>
          This is not a policy choice that could be revoked; it is a property of the
          architecture. Keys exist only in the two participants' browser memory for the
          lifetime of the session. When the room is destroyed, the key material is gone with
          it, and there is no escrow, backup or recovery path — by design.
        </p>
        <p className="text-sm text-tertiary">
          Consequently, the operator cannot restore lost sessions, recover deleted messages,
          or assist law enforcement with the contents of any session. Data recovery requests
          of this kind cannot be fulfilled, for anyone.
        </p>
      </DocSection>

      {/* ---- 4. No warranty & limitation of liability ---- */}
      <DocSection title="4 · No Warranty & Limitation of Liability">
        <p>
          The service is provided{" "}
          <strong className="font-medium text-heading">&quot;AS IS&quot;</strong>, without
          warranty of any kind, express or implied — including merchantability, fitness for a
          particular purpose and non-infringement.
        </p>
        <p>
          Sessions are one-time by design: connections may drop, rooms may burn on schedule or
          earlier, transfers may be interrupted, and destroyed data cannot be restored. You
          accept that{" "}
          <strong className="font-medium text-heading">
            burned content is gone permanently
          </strong>{" "}
          and that SHARD must not be used as the sole storage of anything valuable.
        </p>
        <p>
          To the maximum extent permitted by law, the operators and contributors are not
          liable for any indirect, incidental or consequential damages — lost conversations,
          missed files, business interruption or data loss — arising from the use of, or
          inability to use, the service.
        </p>
      </DocSection>

      {/* ---- 5. Irreversible data destruction ---- */}
      <DocSection title="5 · Irreversible Data Destruction">
        <p>
          Every session has a lifetime (30, 120 or 1440 minutes) and burns immediately when
          either participant disconnects, closes their browser tab, or triggers manual
          destruction. Burning is{" "}
          <strong className="font-medium text-heading">instantaneous and irreversible</strong>:
          messages, attachments, and media state exist in volatile memory only and are purged,
          not archived.
        </p>
        <p>
          This is not a recycle bin and there is no grace period to change your mind. If a
          session is valuable, save what you need{" "}
          <strong className="font-medium text-heading">before</strong> it closes. Once a room
          is gone, no support process, request or payment can bring it back — the data no
          longer exists.
        </p>
      </DocSection>
    </DocShell>
  );
}
