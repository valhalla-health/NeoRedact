// Fixed rotating pool of codenames (NATO phonetic alphabet, minus X-ray and
// Echo — 24) — the only patient identifier that ever leaves this device. No
// real name/HN/DOB is ever attached to a codename here; that mapping is
// Praew's own private sheet, kept outside this app entirely. Keep this list
// identical to CODENAMES in backend/Code.gs — the backend rejects any codename
// it doesn't know, so both files must change in the same commit.
window.NeoRedact = window.NeoRedact || {};
window.NeoRedact.CODENAMES = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Foxtrot', 'Golf', 'Hotel',
  'India', 'Juliett', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa',
  'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey',
  'Yankee', 'Zulu'
];
