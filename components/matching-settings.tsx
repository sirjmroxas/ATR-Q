'use client';

import type {Action, Session} from '../lib/engine';

export function MatchingSettings({session, disabled, onSave}: {
  session: Session;
  disabled: boolean;
  onSave: (action: Action) => void;
}) {
  return <section className="surface settings-panel">
    <h2>ATR matching</h2>
    <p className="muted">ATR is the session’s only matching mode. Fresh partners and first-time encounters come first, with queue order and wait protection keeping rotations fair.</p>
    <form onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      onSave({
        type: 'queueSettings', queueMode: 'atr',
        showStandings: data.has('standings'), selfCheckin: data.has('selfCheckin'), capacityLimit: data.has('capacityLimit'),
      });
    }}>
      <fieldset disabled={disabled} className="matching-options">
        <legend className="sr-only">ATR matching settings</legend>
        <label className="toggle-row"><span><strong>Show live standings on the QR board</strong></span><input type="checkbox" name="standings" defaultChecked={session.showStandings}/></label>
        <label className="toggle-row"><span><strong>Limit players to 12 per court</strong><small>{session.courts.length * 12} active players with {session.courts.length} courts. Turn off to allow more check-ins, up to the 100-player session limit.</small></span><input type="checkbox" role="switch" name="capacityLimit" defaultChecked={session.capacityLimit!==false}/></label>
        <label className="toggle-row"><span><strong>Allow player self-check-in</strong><small>Players with the check-in QR can join until active capacity is full.</small></span><input type="checkbox" name="selfCheckin" defaultChecked={session.selfCheckin}/></label>
      </fieldset>
      <button className="btn primary full-width" type="submit" disabled={disabled}>Save queue settings</button>
    </form>
  </section>;
}
