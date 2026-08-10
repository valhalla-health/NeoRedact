// Fixed rotating pool of codenames (NATO phonetic alphabet, minus X-ray and
// Echo, with November replaced by Nomad — 24). November was dropped 2026-08-10
// because on a chart it reads as a date of birth rather than a codename; Nomad
// keeps the initial letter without that ambiguity. (Echo, dropped 2026-07-20,
// had the same problem — it reads as a cranial ultrasound note.) Prefer names
// that can't be mistaken for clinical content if this pool is ever changed
// again. The only patient identifier that ever leaves this device. No
// real name/HN/DOB is ever attached to a codename here; that mapping is
// Praew's own private sheet, kept outside this app entirely. Keep this list
// identical to CODENAMES in backend/Code.gs — the backend rejects any codename
// it doesn't know, so both files must change in the same commit.
window.NeoRedact = window.NeoRedact || {};
window.NeoRedact.CODENAMES = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Foxtrot', 'Golf', 'Hotel',
  'India', 'Juliett', 'Kilo', 'Lima', 'Mike', 'Nomad', 'Oscar', 'Papa',
  'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey',
  'Yankee', 'Zulu'
];
