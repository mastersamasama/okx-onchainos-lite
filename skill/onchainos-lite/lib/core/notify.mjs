// Payment/state notification queue (upstream payment_notify.rs::drain_events).
// Producers push events during a command; the next envelope printed drains them.
const events = [];
export const pushEvent = (e) => { events.push(e); };
export const drainEvents = () => events.splice(0, events.length);
export const peekEvents = () => [...events];
