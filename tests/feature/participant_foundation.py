"""Verify the additive participant foundation against a local SQLite database."""

from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "drizzle"


def apply_migration(connection, path):
    connection.executescript(path.read_text(encoding="utf-8"))


def add_form(connection, form_id, activity_id):
    connection.execute(
        """INSERT INTO registration_forms
           (id, activity_id, slug, title, description, status, schema_json,
            privacy_notice, version, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'event', '', 'open', '{}', 'notice', 1,
                   'admin-kao19950411', '2026-11-07', '2026-11-07')""",
        (form_id, activity_id, "slug-" + form_id),
    )


def add_submission(connection, submission_id, form_id):
    connection.execute(
        """INSERT INTO registration_submissions
           (id, form_id, form_version, schema_json, answers_json, consent,
            idempotency_hash, source_hash, submitted_at)
           VALUES (?, ?, 1, '{}', '{}', 1, ?, 'source', '2026-11-07')""",
        (submission_id, form_id, "idempotency-" + submission_id),
    )


class ParticipantFoundationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "test.sqlite"
        self.db = sqlite3.connect(self.path, timeout=10)
        self.db.execute("PRAGMA foreign_keys=ON")
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path.name.startswith("0007_"):
                break
            apply_migration(self.db, path)
        add_form(self.db, "form-a", "activity-a")
        add_form(self.db, "form-b", "activity-b")
        add_submission(self.db, "anonymous", "form-a")
        self.db.commit()
        apply_migration(self.db, MIGRATIONS / "0007_participant_foundation.sql")
        self.db.execute(
            "INSERT INTO participants VALUES (?, ?, ?, ?, ?)",
            ("participant-a", "google-sub-a", "same@example.com", "Visitor", "2026-11-07"),
        )
        self.db.execute(
            """INSERT INTO members
               (user_id, username, email, display_name, role, status, created_at)
               VALUES ('member-a', 'member-a', 'same@example.com', 'Member',
                       'member', 'active', '2026-11-07')"""
        )
        for submission_id, form_id in [
            ("participant-1", "form-a"), ("participant-2", "form-a"),
            ("member-1", "form-a"), ("member-2", "form-a"),
            ("different-form", "form-b"), ("invalid-identity", "form-a"),
        ]:
            add_submission(self.db, submission_id, form_id)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_existing_anonymous_submission_is_preserved(self):
        row = self.db.execute(
            "SELECT form_id, answers_json FROM registration_submissions WHERE id='anonymous'"
        ).fetchone()
        self.assertEqual(row, ("form-a", "{}"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM registration_identities").fetchone()[0], 0)

    def test_google_sub_unique_but_email_can_match_member(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO participants VALUES (?, ?, ?, ?, ?)",
                ("other", "google-sub-a", "different@example.com", "Other", "2026-11-07"),
            )
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM members WHERE email='same@example.com'").fetchone()[0], 1)

    def test_session_and_consent_reference_existing_participant(self):
        self.db.execute("INSERT INTO participant_sessions VALUES ('hash', 'participant-a', 2000)")
        self.db.execute("INSERT INTO participant_consents VALUES ('c1', 'participant-a', 'v1', '2026-11-07')")
        for statement in [
            "INSERT INTO participant_sessions VALUES ('bad', 'unknown', 2000)",
            "INSERT INTO participant_consents VALUES ('c2', 'unknown', 'v1', '2026-11-07')",
        ]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(statement)

    def test_identity_requires_exactly_one_owner_and_matching_form(self):
        for params in [
            ("invalid-identity", "form-a", None, None),
            ("invalid-identity", "form-a", "member-a", "participant-a"),
            ("invalid-identity", "form-b", "member-a", None),
            ("invalid-identity", "form-a", "missing", None),
            ("missing-submission", "form-a", None, "participant-a"),
        ]:
            with self.subTest(params=params), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("INSERT INTO registration_identities (submission_id, form_id, member_id, participant_id) VALUES (?, ?, ?, ?)", params)

    def test_duplicate_prevention_and_separate_identity_types(self):
        self.db.execute("INSERT INTO registration_identities (submission_id, form_id, member_id, participant_id) VALUES ('participant-1', 'form-a', NULL, 'participant-a')")
        self.db.execute("INSERT INTO registration_identities (submission_id, form_id, member_id, participant_id) VALUES ('member-1', 'form-a', 'member-a', NULL)")
        self.db.execute("INSERT INTO registration_identities (submission_id, form_id, member_id, participant_id) VALUES ('different-form', 'form-b', NULL, 'participant-a')")
        for params in [
            ("participant-2", "form-a", None, "participant-a"),
            ("member-2", "form-a", "member-a", None),
        ]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("INSERT INTO registration_identities (submission_id, form_id, member_id, participant_id) VALUES (?, ?, ?, ?)", params)

    def test_cancelled_registration_preserves_owner_and_allows_reregistration(self):
        for identity, first, second in [
            ("member-a", "member-1", "member-2"),
            ("participant-a", "participant-1", "participant-2"),
        ]:
            member = identity if identity.startswith("member") else None
            participant = identity if identity.startswith("participant") else None
            self.db.execute(
                "INSERT INTO registration_identities (submission_id, form_id, member_id, participant_id) VALUES (?, 'form-a', ?, ?)",
                (first, member, participant),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(
                    "INSERT INTO registration_identities (submission_id, form_id, member_id, participant_id) VALUES (?, 'form-a', ?, ?)",
                    (second, member, participant),
                )
            self.db.execute("UPDATE registration_identities SET status='cancelled' WHERE submission_id=?", (first,))
            self.db.execute(
                "INSERT INTO registration_identities (submission_id, form_id, member_id, participant_id) VALUES (?, 'form-a', ?, ?)",
                (second, member, participant),
            )
            self.assertEqual(
                self.db.execute(
                    "SELECT member_id, participant_id, status FROM registration_identities WHERE submission_id=?",
                    (first,),
                ).fetchone(),
                (member, participant, "cancelled"),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("UPDATE registration_identities SET status='active' WHERE submission_id=?", (first,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE registration_identities SET status='unknown' WHERE submission_id='member-1'")

    def test_concurrent_registrations_only_one_commits(self):
        self.db.commit()
        barrier = threading.Barrier(2)
        outcomes = []

        def submit(submission_id):
            connection = sqlite3.connect(self.path, timeout=10)
            connection.execute("PRAGMA foreign_keys=ON")
            try:
                barrier.wait(timeout=10)
                connection.execute(
                    "INSERT INTO registration_identities (submission_id, form_id, member_id, participant_id) VALUES (?, 'form-a', NULL, 'participant-a')",
                    (submission_id,),
                )
                connection.commit()
                outcomes.append("committed")
            except sqlite3.IntegrityError:
                connection.rollback()
                outcomes.append("duplicate")
            finally:
                connection.close()

        threads = [threading.Thread(target=submit, args=(submission_id,)) for submission_id in ("participant-1", "participant-2")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertCountEqual(outcomes, ["committed", "duplicate"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
