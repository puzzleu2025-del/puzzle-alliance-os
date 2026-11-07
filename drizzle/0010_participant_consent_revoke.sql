CREATE TRIGGER `participant_consent_revoke_cleanup`
AFTER UPDATE OF `status` ON `participant_consent_state`
WHEN OLD.`status` = 'active' AND NEW.`status` = 'revoked'
BEGIN
  DELETE FROM `participant_sessions` WHERE `participant_id` = NEW.`participant_id`;
  DELETE FROM `participant_pending_identities` WHERE `google_sub` = (SELECT `google_sub` FROM `participants` WHERE `id` = NEW.`participant_id`);
END;
