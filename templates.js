// Fixed-position auto-redact templates for known KCMH paper chart pages.
//
// Each template's regions are hand-measured (as % of image width/height, on
// the EXIF-corrected upright photo) from one reference photo per page —
// see nurse's LocalOnly/photo to text project/template/ source images, not
// committed here (see CLAUDE.md's "Template auto-redact" section for why).
// Coordinates are approximate on purpose: canvas-annotator.js still lets the
// nurse drag-adjust or delete/redraw any seeded region before confirming,
// same as a fully manual box. Auto-seeding only saves her from drawing the
// same two boxes from scratch every time she photographs the same page.
//
// Pages with no identifying fields at all (e.g. the Intake & Output Record
// page) are intentionally NOT listed here — 'manual' is the only option for
// those, same as the original single-label workflow.
window.NeoRedact = window.NeoRedact || {};

(function () {
  'use strict';

  const KCMH_TEMPLATES = [
    {
      id: 'kcmh_p1_critical_care',
      title: 'KCMH · Critical Care Monitoring (หน้า 1)',
      regions: [
        { label: 'KCMH logo', redact: true, xPct: 0.0780, yPct: 0.0346, wPct: 0.2411, hPct: 0.1118 },
        { label: 'Sticker (Name/HN/AN)', redact: true, xPct: 0.2837, yPct: 0.0958, wPct: 0.1702, hPct: 0.0718 },
      ],
    },
    {
      id: 'kcmh_p3_progress_note',
      title: 'KCMH · Progress Note (หน้า 3)',
      regions: [
        { label: 'KCMH logo', redact: true, xPct: 0.0734, yPct: 0, wPct: 0.1736, hPct: 0.0926 },
        { label: 'Sticker (Name/HN/AN)', redact: true, xPct: 0.6442, yPct: 0.0275, wPct: 0.3071, hPct: 0.0876 },
      ],
    },
    {
      id: 'kcmh_p6_admission',
      title: 'KCMH · Admission / Delivery Info (หน้า 6)',
      regions: [
        { label: 'KCMH logo', redact: true, xPct: 0.0621, yPct: 0, wPct: 0.1438, hPct: 0.1078 },
        { label: 'Sticker (Name/HN/AN)', redact: true, xPct: 0.0621, yPct: 0.1005, wPct: 0.3431, hPct: 0.0858 },
      ],
    },
  ];

  function getTemplate(id) {
    return KCMH_TEMPLATES.find((t) => t.id === id) || null;
  }

  window.NeoRedact.templates = { list: KCMH_TEMPLATES, getTemplate };
})();
