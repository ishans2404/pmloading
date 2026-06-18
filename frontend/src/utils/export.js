/**
 * Export Utilities
 * - exportSessionJson: downloads session as JSON file
 * - generateLoadingPdf: creates PDF report using jsPDF + autotable
 */

// ── JSON Export ──────────────────────────────────────────────────
function resolveReportMode(session, explicitMode) {
  if (explicitMode === 'completion' || explicitMode === 'progress') return explicitMode
  return session?.step === 'COMPLETED' ? 'completion' : 'progress'
}

export function exportSessionJson(session) {
  const reportMode = resolveReportMode(session)
  const reportLabel = reportMode === 'completion' ? 'Completion' : 'Progress'
  const payload = buildSubmitPayload(session)
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `PM_Loading_${reportLabel}_${session.rakeId}_${formatDateForFile(new Date())}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function buildSubmitPayload(session) {
  const allSessions = session.allSessions
    ? Object.values(session.allSessions)
    : [session]

  const rakeWagons = session.wagons || []   // [{wagonNo, consigneeCode}]

  // Build a quick lookup: consigneeCode -> destinationCode
  const consToDest = {}
  allSessions.forEach(s =>
    s.consignees.forEach(c => { consToDest[c.consigneeCode] = s.destination?.code })
  )

  // Per-destination block
  const destinations = allSessions.map(s => {
    const destCode = s.destination?.code

    const consignees = s.consignees.map(c => {
      const loaded      = c.plates.filter(p => p.loaded)
      const assignedWagons = [...new Set(loaded.map(p => p.wagonNo).filter(Boolean))]

      return {
        consigneeCode:   c.consigneeCode,
        consigneeName:   c.consigneeName,
        wagons:          assignedWagons,
        platesLoaded:    loaded.length,
        plates: loaded.map(p => ({
          plateNo:   p.plateNo,
          plateType: p.plateType,
          grade:     p.grade,
          heatNo:    p.heatNo,
          ordNo:     p.ordNo  || null,
          size:      p.ordSize || null,
          weight:    p.pcWgt  || null,
          tdc:       p.tdc    || null,
          colourCd:  p.colourCd || null,
          loaded:    p.loaded,
          wagonNo:   p.wagonNo  || null,
          loadedAt:  p.loadedAt || null,
        })),
      }
    })

    // Wagon-level summary for this destination
    const destWagonNos = new Set(
      rakeWagons
        .filter(w => w.consigneeCode && consToDest[w.consigneeCode] === destCode)
        .map(w => w.wagonNo)
    )
    const wagons = [...destWagonNos].map(wNo => {
      const assignment = rakeWagons.find(w => w.wagonNo === wNo) || {}
      const cons = s.consignees.find(c => c.consigneeCode === assignment.consigneeCode)
      const platesInWagon = (cons?.plates || []).filter(p => p.loaded && p.wagonNo === wNo)
      return {
        wagonNo:       wNo,
        consigneeCode: assignment.consigneeCode || null,
        consigneeName: cons?.consigneeName     || null,
        platesLoaded:  platesInWagon.length,
      }
    })

    return {
      code:       s.destination?.code,
      name:       s.destination?.name,
      wagons,
      consignees,
    }
  })

  // Flat wagon list (all destinations)
  const wagons = rakeWagons.map(w => {
    const cons = allSessions
      .flatMap(s => s.consignees)
      .find(c => c.consigneeCode === w.consigneeCode)
    const platesLoaded = (cons?.plates || []).filter(p => p.loaded && p.wagonNo === w.wagonNo).length
    return {
      wagonNo:         w.wagonNo,
      consigneeCode:   w.consigneeCode || null,
      consigneeName:   cons?.consigneeName || null,
      destinationCode: w.consigneeCode ? consToDest[w.consigneeCode] || null : null,
      platesLoaded,
    }
  })

  // Summary
  const allConsignees  = allSessions.flatMap(s => s.consignees)
  const totalLoaded    = allConsignees.reduce((s, c) => s + c.plates.filter(p => p.loaded).length, 0)
  const reportMode = resolveReportMode(session)
  const nowIso = new Date().toISOString()
  const savedAt = session.savedAt || nowIso
  const completedAt = session.completedAt || nowIso

  return {
    rakeId:       session.rakeId,
    operatedBy:   session.operatedBy || 'admin',
    startedAt:    session.startedAt,
    savedAt,
    ...(reportMode === 'completion' ? { completedAt } : {}),
    reportType: reportMode.toUpperCase(),
    summary: {
      totalDestinations: destinations.length,
      totalConsignees:   allConsignees.length,
      totalWagons:       rakeWagons.length,
      platesLoaded:      totalLoaded,
    },
    destinations,
    wagons,
    loadingLog: allSessions.flatMap(s => s.loadingLog || []),
  }
}

// ── PDF Report ───────────────────────────────────────────────────
export async function generateLoadingPdf(session, reportMode) {
  const { default: jsPDF }     = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')

  const resolvedReportMode = resolveReportMode(session, reportMode)
  const isCompletionReport = resolvedReportMode === 'completion'
  const reportHeaderTitle = isCompletionReport
    ? 'BHILAI STEEL PLANT  —  PLATE MILL LOADING COMPLETION REPORT'
    : 'BHILAI STEEL PLANT  —  PLATE MILL LOADING PROGRESS REPORT'
  const reportTimestamp = isCompletionReport
    ? (session.completedAt || session.startedAt || new Date().toISOString())
    : (session.savedAt || new Date().toISOString())
  const completedWagonSet = new Set(Array.isArray(session.completedWagons) ? session.completedWagons : [])

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const PW  = doc.internal.pageSize.getWidth()   // 297
  const PH  = doc.internal.pageSize.getHeight()  // 210
  const M   = 12

  const allSessions   = session.allSessions ? Object.values(session.allSessions) : [session]
  const allConsignees = allSessions.flatMap(s => s.consignees)
  const rakeWagons    = session.wagons || []

  const totalLoaded = allConsignees.reduce((s, c) => s + c.plates.filter(p => p.loaded).length, 0)
  const destString  = allSessions.map(s => `${s.destination?.name || ''} (${s.destination?.code || ''})`).join(' · ')

  // ── Per-page header ────────────────────────────────────────────
  function drawPageHeader() {
    doc.setFillColor(15, 31, 61)
    doc.rect(0, 0, PW, 18, 'F')
    doc.setFillColor(234, 107, 26)
    doc.rect(0, 18, PW, 1.5, 'F')

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10.5)
    doc.setTextColor(255, 255, 255)
    doc.text(reportHeaderTitle, M, 8)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(170, 195, 230)
    doc.text('STEEL AUTHORITY OF INDIA LIMITED  |  FOR INTERNAL USE ONLY', M, 14)

    doc.setFontSize(7.5)
    doc.setTextColor(200, 215, 235)
    doc.text(
      `Rake ID: ${session.rakeId}   |   Dest: ${destString}   |   ${formatDateTimeFull(new Date())}`,
      PW - M, 8, { align: 'right' }
    )
  }

  // ── Page 1: info + summary ─────────────────────────────────────
  drawPageHeader()
  let y = 23

  // Info block
  doc.setFillColor(239, 245, 253)
  doc.setDrawColor(168, 195, 237)
  doc.setLineWidth(0.3)
  doc.roundedRect(M, y, PW - M * 2, 20, 2, 2, 'FD')

  const infoItems = [
    ['RAKE ID',       String(session.rakeId)],
    ['DESTINATION',   destString],
    ['OPERATOR',      session.operatedBy || 'admin'],
    [isCompletionReport ? 'COMPLETED AT' : 'SAVED AT',  formatDateTimeFull(reportTimestamp)],
  ]
  const infoColW = (PW - M * 2) / infoItems.length
  infoItems.forEach(([label, value], i) => {
    const x = M + i * infoColW + 5
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6)
    doc.setTextColor(80, 110, 155)
    doc.text(label, x, y + 6)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    doc.setTextColor(15, 31, 61)
    doc.text(String(value), x, y + 14, { maxWidth: infoColW - 10 })
  })
  y += 24

  // Summary tiles
  // Summary tiles — count only consignees with at least one loaded plate
  const consigneesWithLoads = allConsignees.filter(c => c.plates.some(p => p.loaded)).length
  const totalWeightLoaded = allConsignees.reduce((sum, c) => sum + c.plates
    .filter(p => p.loaded && p.pcWgt)
    .reduce((s, p) => s + (parseFloat(p.pcWgt) || 0), 0)
  , 0)

  // Count wagons that actually have loaded plates
  const loadedWagonsCount = new Set(
    allConsignees
      .flatMap(c => c.plates)
      .filter(p => p.loaded && p.wagonNo)
      .map(p => p.wagonNo)
  ).size

  const tiles = [
    { label: 'CONSIGNEES', value: consigneesWithLoads,        fg: [21, 43, 82],   bg: [240, 245, 255] },
    { label: 'WAGONS',     value: loadedWagonsCount,           fg: [21, 43, 82],   bg: [240, 245, 255] },
    { label: 'LOADED PLATES',     value: totalLoaded,                 fg: [21, 128, 61],  bg: [240, 253, 244] },
    { label: 'WEIGHT (T)', value: Number(totalWeightLoaded.toFixed(1)), fg: [234, 107, 26], bg: [255, 247, 235] },
  ]
  const tileW = (PW - M * 2) / tiles.length
  const tileH = 15
  tiles.forEach((t, i) => {
    const x = M + i * tileW
    doc.setFillColor(...t.bg)
    doc.setDrawColor(210, 220, 235)
    doc.rect(x, y, tileW, tileH, 'FD')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6)
    doc.setTextColor(100, 120, 155)
    doc.text(t.label, x + tileW / 2, y + 4.5, { align: 'center' })
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.setTextColor(...t.fg)
    doc.text(String(t.value), x + tileW / 2, y + 12, { align: 'center' })
  })
  y += tileH + 6

  // ── Per-destination loading detail ─────────────────────────────
  for (const sess of allSessions) {
    if (allSessions.length > 1) {
      if (y > PH - 35) { doc.addPage(); drawPageHeader(); y = 23 }
      doc.setFillColor(27, 56, 101)
      doc.rect(M, y, PW - M * 2, 7, 'F')
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(8)
      doc.setTextColor(255, 255, 255)
      doc.text(
        `DESTINATION:  ${sess.destination?.name || ''}  (${sess.destination?.code || ''})`,
        M + 4, y + 5
      )
      y += 10
    }

    for (const c of sess.consignees) {
      const loadedPlates = c.plates.filter(p => p.loaded)
      if (!loadedPlates.length) continue

      // Sort and group plates by wagon number for a single table with section dividers
      const sortedPlates = [...loadedPlates].sort((a, b) => {
        const wagA = (a.wagonNo || '').trim() || '~~~'
        const wagB = (b.wagonNo || '').trim() || '~~~'
        const wagonCompare = wagA.localeCompare(wagB, undefined, { numeric: true, sensitivity: 'base' })
        if (wagonCompare !== 0) return wagonCompare

        const plateCompare = String(a.plateNo || '').localeCompare(String(b.plateNo || ''), undefined, { numeric: true, sensitivity: 'base' })
        if (plateCompare !== 0) return plateCompare

        return String(a.loadedAt || '').localeCompare(String(b.loadedAt || ''))
      })

      const wagonsForCons = [...new Set(sortedPlates.map(p => (p.wagonNo || '').trim()).filter(Boolean))]
      if (sortedPlates.some(p => !(p.wagonNo || '').trim())) {
        wagonsForCons.push('Unassigned')
      }

      const groupedRows = []
      let currentWagonLabel = null
      let plateSerial = 0

      sortedPlates.forEach(p => {
        const wagonNo = (p.wagonNo || '').trim()
        const wagonLabel = wagonNo || 'Unassigned'
        const isCompletedWagon = wagonNo && completedWagonSet.has(wagonNo)

        if (wagonLabel !== currentWagonLabel) {
          groupedRows.push([
            {
              content: wagonNo ? `Wagon No.: ${wagonLabel}${isCompletedWagon ? '  (Complete)' : ''}` : 'Wagon No.: Unassigned',
              colSpan: 10,
              styles: {
                fillColor: [236, 240, 244],
                textColor: [54, 63, 78],
                fontStyle: 'bold',
                fontSize: 7.3,
                cellPadding: { top: 2, bottom: 2, left: 4, right: 4 },
                lineWidth: { top: 0.25, bottom: 0.25 },
                lineColor: [178, 188, 202],
              },
            },
          ])
          currentWagonLabel = wagonLabel
        }

        plateSerial += 1
        groupedRows.push([
          plateSerial,
          p.plateNo  || '—',
          p.plateType !== 'OK' ? p.plateType : '',
          p.heatNo   || '—',
          p.grade    || '—',
          p.ordSize  || '—',
          p.pcWgt != null ? Number(p.pcWgt).toFixed(3) : '—',
          p.tdc      || '—',
          p.wagonNo  || '—',
        ])
      })

      if (y > PH - 30) { doc.addPage(); drawPageHeader(); y = 23 }

      autoTable(doc, {
        startY: y,
        head: [
          [{ content: `${c.consigneeCode}  —  ${c.consigneeName}`, colSpan: 9 }],
          [{ content: `Wagon(s): ${wagonsForCons.join(', ') || 'N/A'}   |   Plates loaded: ${loadedPlates.length}`, colSpan: 9 }],
          ['Sl.', 'Plate No.', 'Type', 'Heat No.', 'Grade', 'Size (mm)', 'Wt. (T)', 'TDC', 'Wagon No.'],
        ],
        body: groupedRows,
        headStyles: { fillColor: [27, 56, 101], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
        didParseCell(data) {
          if (data.section === 'head') {
            if (data.row.index === 0) {
              data.cell.styles.fillColor  = [15, 31, 61]
              data.cell.styles.fontSize   = 8.5
              data.cell.styles.cellPadding = { top: 3.5, bottom: 3.5, left: 4, right: 2 }
            }
            if (data.row.index === 1) {
              data.cell.styles.fillColor  = [42, 74, 130]
              data.cell.styles.textColor  = [190, 215, 255]
              data.cell.styles.fontSize   = 7
              data.cell.styles.fontStyle  = 'normal'
              data.cell.styles.cellPadding = { top: 2, bottom: 2, left: 4, right: 2 }
            }
            if (data.row.index === 2) {
              data.cell.styles.fillColor  = [21, 43, 82]
              data.cell.styles.fontSize   = 7.5
            }
          }
          if (data.section === 'body' && data.column.index === 8) {
            data.cell.styles.textColor  = [21, 56, 101]
            data.cell.styles.fontStyle  = 'bold'
          }
          if (data.section === 'body' && data.column.index === 2 && data.cell.text?.[0]) {
            data.cell.styles.textColor  = [180, 83, 9]
            data.cell.styles.fontStyle  = 'bold'
          }
        },
        bodyStyles: { fontSize: 7.5, cellPadding: { top: 2, bottom: 2, left: 3, right: 2 } },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: {
          0: { cellWidth: 9,  halign: 'center' },
          1: { cellWidth: 34 },
          2: { cellWidth: 12, halign: 'center' },
          3: { cellWidth: 24 },
          4: { cellWidth: 28 },
          5: { cellWidth: 38 },
          6: { cellWidth: 20, halign: 'right' },
          7: { cellWidth: 28 },
          8: { cellWidth: 34 },
        },
        theme: 'striped',
        margin: { left: M, right: M },
        tableLineColor: [210, 220, 235],
        tableLineWidth: 0.2,
      })

      y = doc.lastAutoTable.finalY + 5
    }
  }

  // ── Wagon summary page ─────────────────────────────────────────
  doc.addPage()
  drawPageHeader()
  y = 23

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(15, 31, 61)
  doc.text(isCompletionReport ? 'WAGON-WISE COMPLETION SUMMARY' : 'WAGON-WISE PROGRESS SUMMARY', M, y)
  y += 5

  const wagonRows = []
  for (const sess of allSessions) {
    for (const c of sess.consignees) {
      const loaded = c.plates.filter(p => p.loaded)
      if (!loaded.length) continue
      const wNos = [...new Set(loaded.map(p => p.wagonNo).filter(Boolean))]
      if (!wNos.length) {
        const loadedWeight = loaded.reduce((s, p) => s + (parseFloat(p.pcWgt) || 0), 0)
        wagonRows.push(['—', c.consigneeCode, c.consigneeName, sess.destination?.code || '—', loaded.length, Number(loadedWeight.toFixed(3)), ''])
      } else {
        wNos.forEach(wNo => {
          const platesInWagon = loaded.filter(p => p.wagonNo === wNo)
          const weightInWagon = platesInWagon.reduce((s, p) => s + (parseFloat(p.pcWgt) || 0), 0)
          wagonRows.push([
            wNo,
            c.consigneeCode,
            c.consigneeName,
            sess.destination?.code || '—',
            platesInWagon.length,
            Number(weightInWagon.toFixed(3)),
            completedWagonSet.has(wNo) ? 'Complete' : '',
          ])
        })
      }
    }
  }

  autoTable(doc, {
    startY: y,
    head: [['Wagon No.', 'Cons. Code', 'Consignee Name', 'Dest.', 'Plates Loaded', 'Wt. (T)', 'Completed']],
    body: wagonRows,
    headStyles: { fillColor: [15, 31, 61], textColor: 255, fontSize: 8, fontStyle: 'bold' },
    bodyStyles: { fontSize: 8, cellPadding: 2.5 },
    didParseCell(data) {
      if (data.section === 'body' && data.column.index === 6 && data.cell.text?.[0]) {
        data.cell.styles.textColor = [21, 128, 61]
        data.cell.styles.fontStyle = 'bold'
      }
    },
    columnStyles: {
      0: { cellWidth: 40 },
      1: { cellWidth: 26 },
      2: { cellWidth: 96 },
      3: { cellWidth: 24 },
      4: { cellWidth: 28, halign: 'center', fontStyle: 'bold' },
      5: { cellWidth: 28, halign: 'center' },
      6: { cellWidth: 24, halign: 'center' },
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    theme: 'striped',
    margin: { left: M, right: M },
  })

  y = doc.lastAutoTable.finalY + 22
  if (y > PH - 45) { doc.addPage(); drawPageHeader(); y = 40 }

  // Signature block
  const sigLabels = ['Prepared By (Operator)', 'Verified By (Supervisor)', 'Approved By (In-charge)']
  const sigW = (PW - M * 2) / 3
  sigLabels.forEach((label, i) => {
    const x = M + i * sigW
    doc.setDrawColor(160, 170, 190)
    doc.setLineWidth(0.4)
    doc.line(x + 8, y + 18, x + sigW - 8, y + 18)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(120, 130, 150)
    doc.text(label, x + sigW / 2, y + 22, { align: 'center' })
    doc.text('Date: ___________', x + sigW / 2, y + 27, { align: 'center' })
  })

  // Footer — page numbers on every page
  const totalPages = doc.internal.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    doc.setFontSize(6.5)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(160, 170, 185)
    doc.text(
      'Bhilai Steel Plant — Plate Mill Division, SAIL  |  This document is for internal use only',
      M, PH - 5
    )
    doc.text(`Page ${p} of ${totalPages}`, PW - M, PH - 5, { align: 'right' })
  }

  const reportLabel = isCompletionReport ? 'Completion' : 'Progress'
  doc.save(`PM_Plate_Loading_${reportLabel}_${session.rakeId}_${formatDateForFile(new Date())}.pdf`)
}

export async function generateProgressReport(session) {
  const { default: jsPDF }     = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')

  const reportTimestamp = session.savedAt || new Date().toISOString()

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const PW  = doc.internal.pageSize.getWidth()   // 210
  const PH  = doc.internal.pageSize.getHeight()  // 297
  const M   = 12

  const allSessions   = (session.allSessions ? Object.values(session.allSessions) : [session])
    .filter(s => s.rakeId === session.rakeId)
  const allConsignees = allSessions.flatMap(s => s.consignees)
  const rakeWagons    = session.wagons || []

  const totalLoaded = allConsignees.reduce((s, c) => s + c.plates.filter(p => p.loaded).length, 0)
  const destString  = allSessions.map(s => `${s.destination?.name || ''} (${s.destination?.code || ''})`).join(' · ')

  // ── Portrait page header ────────────────────────────────────────
  function drawPageHeader(pageNum, totalPages) {
    // Top band
    doc.setFillColor(15, 31, 61)
    doc.rect(0, 0, PW, 14, 'F')
    doc.setFillColor(234, 107, 26)
    doc.rect(0, 14, PW, 1, 'F')

    // Organisation line (left)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    doc.setTextColor(255, 255, 255)
    doc.text('BHILAI STEEL PLANT  —  PLATE MILL LOADING PROGRESS REPORT', M, 6)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6)
    doc.setTextColor(170, 195, 230)
    doc.text('STEEL AUTHORITY OF INDIA LIMITED  |  FOR INTERNAL USE ONLY', M, 11)

    // Page number (right)
    if (totalPages) {
      doc.setFontSize(6.5)
      doc.setTextColor(200, 215, 235)
      doc.text(`Page ${pageNum} of ${totalPages}`, PW - M, 9, { align: 'right' })
    }
  }

  // ── Page 1 ─────────────────────────────────────────────────────
  drawPageHeader(1, null)          // page numbers added in second pass
  let y = 18

  // ── Info block (2-col grid) ─────────────────────────────────────
  const infoBlockH = 20
  doc.setFillColor(239, 245, 253)
  doc.setDrawColor(200, 215, 235)
  doc.setLineWidth(0.25)
  doc.rect(M, y, PW - M * 2, infoBlockH, 'FD')

  const infoItems = [
    ['RAKE ID',     String(session.rakeId)],
    ['DESTINATION', destString],
    ['OPERATOR',    session.operatedBy || 'admin'],
    ['SAVED AT',    formatDateTimeFull(reportTimestamp)],
  ]
  const half = (PW - M * 2) / 2
  infoItems.forEach(([label, value], i) => {
    const col = i % 2
    const row = Math.floor(i / 2)
    const x = M + col * half + 4
    const iy = y + 4 + row * 8.5
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6)
    doc.setTextColor(80, 110, 155)
    doc.text(label, x, iy)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    doc.setTextColor(15, 31, 61)
    doc.text(String(value), x, iy + 4.5, { maxWidth: half - 8 })
  })
  y += infoBlockH + 3

  // ── Summary tiles ───────────────────────────────────────────────
  const consigneesWithLoads = allConsignees.filter(c => c.plates.some(p => p.loaded)).length
  const totalWeightLoaded = allConsignees.reduce((sum, c) => sum + c.plates
    .filter(p => p.loaded && p.pcWgt)
    .reduce((s, p) => s + (parseFloat(p.pcWgt) || 0), 0)
  , 0)
  const loadedWagonsCount = new Set(
    allConsignees.flatMap(c => c.plates).filter(p => p.loaded && p.wagonNo).map(p => p.wagonNo)
  ).size

  const tiles = [
    { label: 'CONSIGNEES',    value: consigneesWithLoads,                      fg: [21, 43, 82],   bg: [240, 245, 255] },
    { label: 'WAGONS',        value: loadedWagonsCount,                        fg: [21, 43, 82],   bg: [240, 245, 255] },
    { label: 'LOADED PLATES', value: totalLoaded,                              fg: [21, 128, 61],  bg: [240, 253, 244] },
    { label: 'WEIGHT (T)',    value: Number(totalWeightLoaded.toFixed(1)),      fg: [234, 107, 26], bg: [255, 247, 235] },
  ]
  const tileW = (PW - M * 2) / tiles.length
  const tileH = 12
  tiles.forEach((t, i) => {
    const x = M + i * tileW
    doc.setFillColor(...t.bg)
    doc.setDrawColor(210, 220, 235)
    doc.setLineWidth(0.25)
    doc.rect(x, y, tileW, tileH, 'FD')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(5.5)
    doc.setTextColor(100, 120, 155)
    doc.text(t.label, x + tileW / 2, y + 4.5, { align: 'center' })
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(...t.fg)
    doc.text(String(t.value), x + tileW / 2, y + 10, { align: 'center' })
  })
  y += tileH + 4

  // ── Per-destination sections ────────────────────────────────────
  for (const sess of allSessions) {
    // Destination banner (always shown, even for single dest)
    if (y > PH - 40) { doc.addPage(); drawPageHeader(doc.internal.getNumberOfPages(), null); y = 18 }
    doc.setFillColor(15, 31, 61)
    doc.rect(M, y, PW - M * 2, 6, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7)
    doc.setTextColor(255, 255, 255)
    doc.text(
      `DESTINATION: ${sess.destination?.name || ''}  (${sess.destination?.code || ''})`,
      M + 3, y + 4.2
    )
    y += 7

    for (const c of sess.consignees) {
      const loadedPlates = c.plates.filter(p => p.loaded)
      if (!loadedPlates.length) continue

      const sortedPlates = [...loadedPlates].sort((a, b) => {
        const wagA = (a.wagonNo || '').trim() || '~~~'
        const wagB = (b.wagonNo || '').trim() || '~~~'
        const wagonCompare = wagA.localeCompare(wagB, undefined, { numeric: true, sensitivity: 'base' })
        if (wagonCompare !== 0) return wagonCompare
        const plateCompare = String(a.plateNo || '').localeCompare(String(b.plateNo || ''), undefined, { numeric: true, sensitivity: 'base' })
        if (plateCompare !== 0) return plateCompare
        return String(a.loadedAt || '').localeCompare(String(b.loadedAt || ''))
      })

      const wagonsForCons = [...new Set(sortedPlates.map(p => (p.wagonNo || '').trim()).filter(Boolean))]
      if (sortedPlates.some(p => !(p.wagonNo || '').trim())) wagonsForCons.push('Unassigned')

      const groupedRows = []
      let currentWagonLabel = null
      let plateSerial = 0

      sortedPlates.forEach(p => {
        const wagonNo = (p.wagonNo || '').trim()
        const wagonLabel = wagonNo || 'Unassigned'
        if (wagonLabel !== currentWagonLabel) {
          groupedRows.push([{
            content: wagonNo ? `Wagon No.:  ${wagonLabel}` : 'Wagon No.:  Unassigned',
            colSpan: 9,
            styles: {
              fillColor: [226, 232, 240],
              textColor: [30, 42, 68],
              fontStyle: 'bold',
              fontSize: 6.8,
              cellPadding: { top: 1.8, bottom: 1.8, left: 4, right: 4 },
              lineWidth: { top: 0.3, bottom: 0.3 },
              lineColor: [160, 175, 200],
            },
          }])
          currentWagonLabel = wagonLabel
        }
        plateSerial += 1
        groupedRows.push([
          plateSerial, p.plateNo || '—', p.plateType !== 'OK' ? p.plateType : '',
          p.heatNo || '—', p.grade || '—', p.ordSize || '—',
          p.pcWgt != null ? Number(p.pcWgt).toFixed(3) : '—',
          p.tdc || '—', p.ordNo || '—',
        ])
      })

      if (y > PH - 35) { doc.addPage(); drawPageHeader(doc.internal.getNumberOfPages(), null); y = 18 }

      autoTable(doc, {
        startY: y,
        head: [
          [{ content: `${c.consigneeCode}  —  ${c.consigneeName}`, colSpan: 9,
             styles: { fillColor: [21, 43, 82], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8, cellPadding: { top: 3, bottom: 3, left: 4, right: 4 } } }],
          [{ content: `Wagon(s): ${wagonsForCons.join(', ') || 'N/A'}   |   Plates loaded: ${loadedPlates.length}`, colSpan: 9,
             styles: { fillColor: [37, 65, 120], textColor: [185, 210, 255], fontStyle: 'normal', fontSize: 6.5, cellPadding: { top: 1.8, bottom: 1.8, left: 4, right: 4 } } }],
          ['Sl.', 'Plate No.', 'Type', 'Heat No.', 'Grade', 'Size (mm)', 'Wt. (T)', 'TDC', 'Order No.'],
        ],
        body: groupedRows,
        headStyles: { fillColor: [21, 43, 82], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 6.8 },
        didParseCell(data) {
          if (data.section === 'head' && data.row.index === 2) {
            data.cell.styles.fillColor  = [27, 56, 101]
            data.cell.styles.fontSize   = 6.5
            data.cell.styles.cellPadding = { top: 2, bottom: 2, left: 2, right: 2 }
          }
          if (data.section === 'body' && data.column.index === 8) {
            data.cell.styles.textColor  = [21, 56, 101]
            data.cell.styles.fontStyle  = 'bold'
          }
          if (data.section === 'body' && data.column.index === 2 && data.cell.text?.[0]) {
            data.cell.styles.textColor  = [180, 83, 9]
            data.cell.styles.fontStyle  = 'bold'
          }
        },
        bodyStyles: { fontSize: 7, cellPadding: { top: 1.8, bottom: 1.8, left: 2, right: 2 } },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: {
          0: { cellWidth: 8,  halign: 'center' },
          1: { cellWidth: 28 },
          2: { cellWidth: 11, halign: 'center' },
          3: { cellWidth: 22 },
          4: { cellWidth: 22 },
          5: { cellWidth: 33 },
          6: { cellWidth: 16, halign: 'right' },
          7: { cellWidth: 22 },
          8: { cellWidth: 'auto' },
        },
        theme: 'striped',
        margin: { left: M, right: M },
        tableLineColor: [210, 220, 235],
        tableLineWidth: 0.15,
      })
      y = doc.lastAutoTable.finalY + 4
    }
  }

  // ── Wagon-wise summary (new page) ───────────────────────────────
  doc.addPage()
  drawPageHeader(doc.internal.getNumberOfPages(), null)
  y = 18

  doc.setFillColor(15, 31, 61)
  doc.rect(M, y, PW - M * 2, 6, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7)
  doc.setTextColor(255, 255, 255)
  doc.text('WAGON-WISE LOADING SUMMARY', M + 3, y + 4.2)
  y += 8

  const wagonRows = []
  for (const sess of allSessions) {
    for (const c of sess.consignees) {
      const loaded = c.plates.filter(p => p.loaded)
      if (!loaded.length) continue
      const wNos = [...new Set(loaded.map(p => p.wagonNo).filter(Boolean))]
      if (!wNos.length) {
        const loadedWeight = loaded.reduce((s, p) => s + (parseFloat(p.pcWgt) || 0), 0)
        wagonRows.push(['—', c.consigneeCode, c.consigneeName, sess.destination?.code || '—', loaded.length, Number(loadedWeight.toFixed(3))])
      } else {
        wNos.forEach(wNo => {
          const platesInWagon = loaded.filter(p => p.wagonNo === wNo)
          const weightInWagon = platesInWagon.reduce((s, p) => s + (parseFloat(p.pcWgt) || 0), 0)
          wagonRows.push([wNo, c.consigneeCode, c.consigneeName, sess.destination?.code || '—', platesInWagon.length, Number(weightInWagon.toFixed(3))])
        })
      }
    }
  }

  autoTable(doc, {
    startY: y,
    head: [['Wagon No.', 'Cons. Code', 'Consignee Name', 'Dest.', 'Plates Loaded', 'Wt. (T)']],
    body: wagonRows,
    headStyles: { fillColor: [21, 43, 82], textColor: [255, 255, 255], fontSize: 7, fontStyle: 'bold', cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 } },
    bodyStyles: { fontSize: 7.5, cellPadding: { top: 2, bottom: 2, left: 3, right: 3 } },
    columnStyles: {
      0: { cellWidth: 36 },
      1: { cellWidth: 24 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 20 },
      4: { cellWidth: 24, halign: 'center', fontStyle: 'bold' },
      5: { cellWidth: 22, halign: 'right' },
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    theme: 'striped',
    margin: { left: M, right: M },
    tableLineColor: [210, 220, 235],
    tableLineWidth: 0.15,
  })

  y = doc.lastAutoTable.finalY + 16
  if (y > PH - 42) { doc.addPage(); drawPageHeader(doc.internal.getNumberOfPages(), null); y = 28 }

  // ── Signature block ─────────────────────────────────────────────
  const sigLabels = ['Prepared By (Operator)', 'Verified By (Supervisor)', 'Approved By (In-charge)']
  const sigW = (PW - M * 2) / 3
  sigLabels.forEach((label, i) => {
    const x = M + i * sigW
    doc.setDrawColor(120, 135, 160)
    doc.setLineWidth(0.35)
    doc.line(x + 6, y + 16, x + sigW - 6, y + 16)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.5)
    doc.setTextColor(100, 115, 140)
    doc.text(label, x + sigW / 2, y + 20, { align: 'center' })
    doc.text('Date: _______________', x + sigW / 2, y + 25, { align: 'center' })
  })

  // ── Second pass: inject correct page numbers & footer ──────────
  const totalPages = doc.internal.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    // Re-draw header with correct total (header band already painted; just overlay text)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.5)
    doc.setTextColor(200, 215, 235)
    // Clear old placeholder area and write correct number
    doc.setFillColor(15, 31, 61)
    doc.rect(PW - M - 28, 4, 30, 7, 'F')
    doc.text(`Page ${p} of ${totalPages}`, PW - M, 9, { align: 'right' })

    // Footer
    doc.setFillColor(230, 235, 242)
    doc.rect(0, PH - 7, PW, 7, 'F')
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6)
    doc.setTextColor(80, 95, 120)
    doc.text(
      'Bhilai Steel Plant — Plate Mill Division, SAIL  |  This document is for internal use only',
      M, PH - 2.5
    )
    doc.text(`Generated: ${formatDateTimeFull(new Date())}`, PW - M, PH - 2.5, { align: 'right' })
  }

  doc.save(`PM_Plate_Loading_Progress_${session.rakeId}_${formatDateForFile(new Date())}.pdf`)
}

// ── Helpers ──────────────────────────────────────────────────────
function formatDateForFile(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`
}

function formatDateTimeFull(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

// ── Wagon-wise submission ─────────────────────────────────────────
const FAILED_SUBMISSIONS_KEY = 'bsp_failed_submissions'

export function buildWagonPayloads(session) {
  const allSessions = session.allSessions
    ? Object.values(session.allSessions)
    : [session]

  const rakeWagons = session.wagons || []
  const payloads = []

  for (const sess of allSessions) {
    for (const wagon of rakeWagons) {
      if (!wagon.consigneeCode) continue
      const cons = sess.consignees.find(c => c.consigneeCode === wagon.consigneeCode)
      if (!cons) continue

      const loadedPlates = cons.plates.filter(p => p.loaded && p.wagonNo === wagon.wagonNo)
      if (!loadedPlates.length) continue

      payloads.push({
        rakeId:          session.rakeId,
        wagonNo:         wagon.wagonNo,
        consigneeCode:   cons.consigneeCode,
        destinationCode: sess.destination?.code || null,
        operatedBy:      session.operatedBy || 'admin',
        completedAt:     session.completedAt || new Date().toISOString(),
        plateNo: loadedPlates.map(p => p.plateNo),
      })
    }
  }

  return payloads
}

export async function submitWagonRequests(payloads, submitFn, onProgress, status = 1) {
  const results = { succeeded: [], failed: [] }

  await Promise.allSettled(
    payloads.map(async (payload) => {
      try {
        await submitFn(payload, status)
        results.succeeded.push(payload)
      } catch (err) {
        results.failed.push({ payload, error: err.message })
      }
      onProgress?.({
        succeeded: results.succeeded.length,
        failed:    results.failed.length,
        total:     payloads.length,
      })
    })
  )

  if (results.failed.length > 0) {
    try {
      localStorage.setItem(FAILED_SUBMISSIONS_KEY, JSON.stringify(results.failed))
    } catch {}
  } else {
    localStorage.removeItem(FAILED_SUBMISSIONS_KEY)
  }

  return results
}

export function loadFailedSubmissions() {
  try { return JSON.parse(localStorage.getItem(FAILED_SUBMISSIONS_KEY) || '[]') } catch { return [] }
}

export function clearFailedSubmissions() {
  localStorage.removeItem(FAILED_SUBMISSIONS_KEY)
}

export async function generateReportHomepage(rakeId, loadedData) {
  const { default: jsPDF }     = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')

  if (!Array.isArray(loadedData) || loadedData.length === 0) {
    throw new Error('No loaded plate data available for this rake.')
  }

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const PW  = doc.internal.pageSize.getWidth()
  const PH  = doc.internal.pageSize.getHeight()
  const M   = 12

  // Extract TRAMS ID from first row that has it
  const tramsId = loadedData.find(r => r.RAKEID_TRAMS)?.RAKEID_TRAMS || null

  // Group by destination → consignee → plates
  const destMap = {}
  for (const row of loadedData) {
    const destCode = String(row.WAGON_DEST_CD || row.DEST_CD1 || '').trim()
    const destName = String(row.DEST_NM1 || '').trim()
    const consCode = String(row.DISPATCH_CD || '').trim()
    const consName = String(row.CUST_NM || '').trim()
    const wagonNo  = String(row.DISPATCH_NM || '').trim()
    const plateNo  = String(row.CHILD_PLATE_NO || '').trim()
    const heatNo   = String(row.HEAT_NO || '').trim()
    const grade    = String(row.GRADE || '').trim()
    const ordSize  = String(row.ORD_SIZE || '').trim()
    const pcWgt    = row.PC_WGT != null ? parseFloat(row.PC_WGT) : null
    const tdc      = String(row.TDC || '').trim()
    const ordNo    = String(row.ORD_NO || '').trim()
    const status   = String(row.LOADING_STATUS || '').trim()

    if (!plateNo && !consCode && !wagonNo) continue
    const dKey = destCode || 'UNKNOWN'
    if (!destMap[dKey]) destMap[dKey] = { destCode, destName, consignees: {} }
    const cKey = consCode || 'UNKNOWN'
    if (!destMap[dKey].consignees[cKey]) {
      destMap[dKey].consignees[cKey] = { consCode, consName, plates: [] }
    }
    destMap[dKey].consignees[cKey].plates.push({ plateNo, heatNo, grade, ordSize, pcWgt, tdc, ordNo, wagonNo, status })
  }

  const allDests     = Object.values(destMap)
  const totalPlates  = loadedData.length
  const totalWeight  = loadedData.reduce((s, r) => s + (r.PC_WGT != null ? parseFloat(r.PC_WGT) : 0), 0)
  const uniqueWagons = new Set(loadedData.map(r => String(r.DISPATCH_NM || '').trim()).filter(Boolean))
  const uniqueCons   = new Set(loadedData.map(r => String(r.DISPATCH_CD || '').trim()).filter(Boolean))
  const destString   = allDests.map(d => `${d.destName} (${d.destCode})`).filter(s => s.trim() !== '()').join(' · ') || '—'

  // ── Header (drawn on every page) ────────────────────────────────
  function drawPageHeader() {
    doc.setFillColor(15, 31, 61)
    doc.rect(0, 0, PW, 16, 'F')
    doc.setFillColor(234, 107, 26)
    doc.rect(0, 16, PW, 1.2, 'F')

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    doc.setTextColor(255, 255, 255)
    doc.text('BHILAI STEEL PLANT  —  PLATE MILL LOADED PLATES REPORT', M, 7.5)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6)
    doc.setTextColor(155, 185, 225)
    doc.text('STEEL AUTHORITY OF INDIA LIMITED  |  FOR INTERNAL USE ONLY', M, 13)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6.5)
    doc.setTextColor(195, 215, 245)
    doc.text(`Rake: ${rakeId}${tramsId ? `  |  TRAMS: ${tramsId}` : ''}`, PW - M, 8, { align: 'right' })
  }

  // ── Page 1 ──────────────────────────────────────────────────────
  drawPageHeader()
  let y = 21

  // Info block — RAKE ID | DESTINATION | TRAMS ID | TOTAL PLATES
  const infoItems = [
    { label: 'RAKE ID',      value: String(rakeId),         large: true  },
    { label: 'DESTINATION',  value: destString,             large: false },
    { label: 'TRAMS ID',     value: tramsId || '—',         large: true  },
    { label: 'TOTAL PLATES', value: String(totalPlates),    large: true  },
  ]
  const infoBlockH = 19
  const infoColW   = (PW - M * 2) / infoItems.length

  doc.setFillColor(240, 246, 255)
  doc.setDrawColor(190, 212, 240)
  doc.setLineWidth(0.3)
  doc.roundedRect(M, y, PW - M * 2, infoBlockH, 1.5, 1.5, 'FD')

  // Vertical dividers
  doc.setDrawColor(210, 228, 248)
  doc.setLineWidth(0.2)
  for (let i = 1; i < infoItems.length; i++) {
    const sx = M + i * infoColW
    doc.line(sx, y + 3, sx, y + infoBlockH - 3)
  }

  infoItems.forEach(({ label, value, large }, i) => {
    const x = M + i * infoColW + 4
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(5.8)
    doc.setTextColor(88, 118, 165)
    doc.text(label, x, y + 6.5)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(large ? 9 : 7.5)
    doc.setTextColor(12, 28, 58)
    doc.text(String(value), x, y + 15, { maxWidth: infoColW - 7 })
  })
  y += infoBlockH + 4

  // Summary tiles
  const tiles = [
    { label: 'CONSIGNEES',    value: uniqueCons.size,                fg: [21, 43, 82],   bg: [236, 244, 255], br: [175, 205, 240] },
    { label: 'WAGONS',        value: uniqueWagons.size,              fg: [21, 43, 82],   bg: [236, 244, 255], br: [175, 205, 240] },
    { label: 'PLATES LOADED', value: totalPlates,                    fg: [14, 100, 48],  bg: [236, 252, 241], br: [150, 218, 178] },
    { label: 'TOTAL WT. (T)', value: Number(totalWeight.toFixed(2)), fg: [162, 72, 8],   bg: [255, 246, 232], br: [242, 190, 135] },
  ]
  const tileW = (PW - M * 2) / tiles.length
  const tileH = 14
  tiles.forEach((t, i) => {
    const x = M + i * tileW
    doc.setFillColor(...t.bg)
    doc.setDrawColor(...t.br)
    doc.setLineWidth(0.3)
    doc.rect(x, y, tileW, tileH, 'FD')
    // Top colour bar
    doc.setFillColor(...t.fg)
    doc.rect(x, y, tileW, 1.8, 'F')

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(5.5)
    doc.setTextColor(95, 115, 150)
    doc.text(t.label, x + tileW / 2, y + 7.5, { align: 'center' })

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.setTextColor(...t.fg)
    doc.text(String(t.value), x + tileW / 2, y + 13, { align: 'center' })
  })
  y += tileH + 5

  // ── Per-destination sections ─────────────────────────────────────
  for (const dest of allDests) {
    if (y > PH - 48) { doc.addPage(); drawPageHeader(); y = 21 }

    // Destination banner
    doc.setFillColor(21, 43, 82)
    doc.rect(M, y, PW - M * 2, 7, 'F')
    doc.setFillColor(234, 107, 26)
    doc.rect(M, y + 7, PW - M * 2, 0.8, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    doc.setTextColor(255, 255, 255)
    doc.text(`DESTINATION: ${dest.destName || '—'}  (${dest.destCode || '—'})`, M + 4, y + 4.8)
    y += 9

    for (const cons of Object.values(dest.consignees)) {
      if (!cons.plates.length) continue

      const sortedPlates = [...cons.plates].sort((a, b) => {
        const wagA = (a.wagonNo || '').trim() || '~~~'
        const wagB = (b.wagonNo || '').trim() || '~~~'
        const wc = wagA.localeCompare(wagB, undefined, { numeric: true, sensitivity: 'base' })
        if (wc !== 0) return wc
        return String(a.plateNo || '').localeCompare(String(b.plateNo || ''), undefined, { numeric: true, sensitivity: 'base' })
      })

      const wagonsForCons = [...new Set(sortedPlates.map(p => (p.wagonNo || '').trim()).filter(Boolean))]
      if (sortedPlates.some(p => !(p.wagonNo || '').trim())) wagonsForCons.push('Unassigned')

      const groupedRows = []
      let currentWagonLabel = null
      let plateSerial = 0  // reset per wagon

      sortedPlates.forEach(p => {
        const wagonNo    = (p.wagonNo || '').trim()
        const wagonLabel = wagonNo || 'Unassigned'

        if (wagonLabel !== currentWagonLabel) {
          plateSerial = 0  // restart numbering for each wagon
          groupedRows.push([{
            content: wagonNo ? `Wagon No.: ${wagonLabel}` : 'Wagon No.: Unassigned',
            colSpan: 9,
            styles: {
              fillColor: [226, 235, 248],
              textColor: [18, 40, 80],
              fontStyle: 'bold',
              fontSize: 7,
              cellPadding: { top: 2.2, bottom: 2.2, left: 4, right: 4 },
              lineWidth: { top: 0.3, bottom: 0.3 },
              lineColor: [165, 190, 225],
            },
          }])
          currentWagonLabel = wagonLabel
        }

        plateSerial += 1
        groupedRows.push([
          plateSerial,
          p.plateNo  || '—',
          p.heatNo   || '—',
          p.grade    || '—',
          p.ordSize  || '—',
          p.pcWgt != null ? Number(p.pcWgt).toFixed(3) : '—',
          p.tdc      || '—',
          p.ordNo    || '—',
          p.status   || '—',
        ])
      })

      if (y > PH - 40) { doc.addPage(); drawPageHeader(); y = 21 }

      const totalConsWeight = cons.plates.reduce((s, p) => s + (p.pcWgt ? parseFloat(p.pcWgt) : 0), 0)

      autoTable(doc, {
        startY: y,
        head: [
          [{ content: `${cons.consCode || '—'}  —  ${cons.consName || '—'}`, colSpan: 9,
             styles: { fillColor: [15, 31, 61], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5,
                       cellPadding: { top: 3.5, bottom: 3.5, left: 4, right: 4 } } }],
          [{ content: `Wagon(s): ${wagonsForCons.join(', ') || 'N/A'}   |   Plates: ${cons.plates.length}   |   Weight: ${totalConsWeight.toFixed(2)} T`,
             colSpan: 9,
             styles: { fillColor: [34, 62, 116], textColor: [185, 210, 255], fontStyle: 'normal', fontSize: 6.5,
                       cellPadding: { top: 2, bottom: 2, left: 4, right: 4 } } }],
          ['Sl.', 'Plate No.', 'Heat No.', 'Grade', 'Size (mm)', 'Wt. (T)', 'TDC', 'Order No.', 'Status'],
        ],
        body: groupedRows,
        headStyles: { fillColor: [27, 56, 101], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 6.8 },
        didParseCell(data) {
          if (data.section === 'head' && data.row.index === 2) {
            data.cell.styles.fillColor   = [30, 60, 112]
            data.cell.styles.fontSize    = 6.5
            data.cell.styles.cellPadding = { top: 2.5, bottom: 2.5, left: 2.5, right: 2 }
          }
          if (data.section === 'body' && data.column.index === 0) {
            data.cell.styles.fontStyle = 'bold'
            data.cell.styles.textColor = [45, 65, 100]
          }
          if (data.section === 'body' && data.column.index === 8 && data.cell.text?.[0]) {
            const s = String(data.cell.text[0]).toUpperCase()
            if (s.includes('DA CREATED')) {
              data.cell.styles.textColor = [14, 100, 48]
              data.cell.styles.fontStyle = 'bold'
            } else if (s.includes('LOADING STARTED')) {
              data.cell.styles.textColor = [182, 78, 8]
              data.cell.styles.fontStyle = 'bold'
            }
          }
        },
        bodyStyles: { fontSize: 7, cellPadding: { top: 1.8, bottom: 1.8, left: 2.5, right: 2 } },
        alternateRowStyles: { fillColor: [249, 251, 255] },
        columnStyles: {
          0: { cellWidth: 8,   halign: 'center' },
          1: { cellWidth: 26 },
          2: { cellWidth: 20 },
          3: { cellWidth: 24 },
          4: { cellWidth: 27 },
          5: { cellWidth: 16,  halign: 'right' },
          6: { cellWidth: 20 },
          7: { cellWidth: 22 },
          8: { cellWidth: 'auto' },
        },
        theme: 'striped',
        margin: { left: M, right: M },
        tableLineColor: [200, 215, 235],
        tableLineWidth: 0.2,
      })
      y = doc.lastAutoTable.finalY + 5
    }
  }

  // ── Wagon-wise summary page ──────────────────────────────────────
  doc.addPage()
  drawPageHeader()
  y = 21

  doc.setFillColor(21, 43, 82)
  doc.rect(M, y, PW - M * 2, 7, 'F')
  doc.setFillColor(234, 107, 26)
  doc.rect(M, y + 7, PW - M * 2, 0.8, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(255, 255, 255)
  doc.text('WAGON-WISE LOADING SUMMARY', M + 4, y + 4.8)
  y += 10

  const wagonSumMap = {}
  for (const row of loadedData) {
    const wNo = String(row.DISPATCH_NM || '').trim()
    if (!wNo) continue
    if (!wagonSumMap[wNo]) {
      wagonSumMap[wNo] = {
        wagonNo:  wNo,
        consCode: String(row.DISPATCH_CD || '').trim(),
        consName: String(row.CUST_NM     || '').trim(),
        destCode: String(row.WAGON_DEST_CD || row.DEST_CD1 || '').trim(),
        plates:   0,
        weight:   0,
      }
    }
    wagonSumMap[wNo].plates++
    wagonSumMap[wNo].weight += row.PC_WGT != null ? parseFloat(row.PC_WGT) : 0
  }

  const wagonSumRows = Object.values(wagonSumMap)
    .sort((a, b) => a.wagonNo.localeCompare(b.wagonNo))
    .map((w, i) => [i + 1, w.wagonNo, w.consCode, w.consName, w.destCode, w.plates, Number(w.weight.toFixed(3))])

  autoTable(doc, {
    startY: y,
    head: [['#', 'Wagon No.', 'Cons. Code', 'Consignee Name', 'Dest.', 'Plates', 'Wt. (T)']],
    body: wagonSumRows,
    headStyles: { fillColor: [27, 56, 101], textColor: [255, 255, 255], fontSize: 7, fontStyle: 'bold',
                  cellPadding: { top: 3, bottom: 3, left: 3, right: 3 } },
    bodyStyles: { fontSize: 7.5, cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 } },
    didParseCell(data) {
      if (data.section === 'body' && data.column.index === 0) {
        data.cell.styles.fontStyle = 'bold'
        data.cell.styles.textColor = [45, 65, 100]
        data.cell.styles.halign    = 'center'
      }
      if (data.section === 'body' && data.column.index === 1) {
        data.cell.styles.fontStyle = 'bold'
        data.cell.styles.textColor = [15, 31, 61]
      }
    },
    columnStyles: {
      0: { cellWidth: 8  },
      1: { cellWidth: 38 },
      2: { cellWidth: 22 },
      3: { cellWidth: 'auto' },
      4: { cellWidth: 18 },
      5: { cellWidth: 18, halign: 'center', fontStyle: 'bold' },
      6: { cellWidth: 22, halign: 'right' },
    },
    alternateRowStyles: { fillColor: [249, 251, 255] },
    theme: 'striped',
    margin: { left: M, right: M },
    tableLineColor: [200, 215, 235],
    tableLineWidth: 0.2,
  })

  y = doc.lastAutoTable.finalY + 18
  if (y > PH - 55) { doc.addPage(); drawPageHeader(); y = 30 }

  // Signature block
  const sigLabels = ['Prepared By (Operator)', 'Verified By (Supervisor)', 'Approved By (In-charge)']
  const sigW = (PW - M * 2) / 3
  sigLabels.forEach((label, i) => {
    const x = M + i * sigW
    doc.setDrawColor(130, 150, 180)
    doc.setLineWidth(0.4)
    doc.line(x + 6, y + 16, x + sigW - 6, y + 16)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.5)
    doc.setTextColor(100, 118, 148)
    doc.text(label, x + sigW / 2, y + 20, { align: 'center' })
    doc.text('Date: _______________', x + sigW / 2, y + 25, { align: 'center' })
  })

  // Footer + page numbers (second pass — totalPages now known)
  const totalPages = doc.internal.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    doc.setFillColor(232, 237, 246)
    doc.rect(0, PH - 8, PW, 8, 'F')
    doc.setDrawColor(190, 208, 230)
    doc.setLineWidth(0.3)
    doc.line(0, PH - 8, PW, PH - 8)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6)
    doc.setTextColor(82, 102, 132)
    doc.text('Bhilai Steel Plant — Plate Mill Division, SAIL  |  For internal use only', M, PH - 3)
    doc.text(`Generated: ${formatDateTimeFull(new Date().toISOString())}`, PW / 2, PH - 3, { align: 'center' })
    doc.text(`Page ${p} of ${totalPages}`, PW - M, PH - 3, { align: 'right' })
  }

  doc.save(`PM_Loaded_Report_${rakeId}_${formatDateForFile(new Date())}.pdf`)
}
