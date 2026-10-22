import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import './App.css'
import { createEngine } from './engine/core.js'
import { loadSampleSmall, loadSampleLarge } from './fixtures/loadSample.js'

const TOTAL_ROWS = 50
const TOTAL_COLS = 50
const VIRTUAL_ROW_HEIGHT = 32
const VIRTUAL_OVERSCAN = 10

// Shift relative formula references while preserving $-anchored references.
function shiftFillFormula(raw, rowOffset, colOffset) {
  return raw.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (full, colLock, letters, rowLock, digits) => {
    let col = 0
    for (const char of letters) col = col * 26 + char.charCodeAt(0) - 64
    col--
    const row = Number(digits) - 1
    const newCol = colLock ? col : col + colOffset
    const newRow = rowLock ? row : row + rowOffset
    if (newCol < 0 || newRow < 0) return '#REF!'
    let n = newCol + 1
    let label = ''
    while (n) { n--; label = String.fromCharCode(65 + n % 26) + label; n = Math.floor(n / 26) }
    return `${colLock}${label}${rowLock}${newRow + 1}`
  })
}

function extendFillValue(seedValues, index) {
  const first = String(seedValues[0] ?? '')
  if (first.startsWith('=')) return first
  const allNumbers = seedValues.every(v => String(v).trim() !== '' && Number.isFinite(Number(v)))
  if (allNumbers && seedValues.length >= 2) {
    const step = Number(seedValues[1]) - Number(seedValues[0])
    return String(Number(seedValues[0]) + step * index)
  }
  const match = first.match(/^(.*?)(\d+)$/)
  if (match && seedValues.length >= 2) {
    const second = String(seedValues[1]).match(/^(.*?)(\d+)$/)
    if (second && second[1] === match[1]) {
      const step = Number(second[2]) - Number(match[2])
      return match[1] + String(Number(match[2]) + step * index).padStart(match[2].length, '0')
    }
  }
  return String(seedValues[index % seedValues.length] ?? '')
}


// Challenge 4: transparent, local natural-language query interpreter (no external AI API).
function interpretSheetQuery(input, columns) {
  const query = input.trim()
  const lower = query.toLowerCase()
  if (!query) return { error: 'Enter a spreadsheet question or command.' }
  const columnMatch = lower.match(/\b(?:column|col)\s+([a-z]{1,3})\b/) || lower.match(/\b([a-z]{1,3})\s+column\b/)
  let col = -1
  if (columnMatch) {
    col = [...columnMatch[1].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
  } else {
    // Allow bare single-letter references for queries such as "sum B".
    const match = lower.match(/\b(?:sum|total|average|avg|mean|minimum|min|maximum|max|count|sort|filter)\s+(?:of\s+)?([a-z])\b/)
    if (match) col = match[1].toUpperCase().charCodeAt(0) - 65
  }
  if (/\b(reset|clear)\s+(?:the\s+)?(?:view|filters?|sorting)\b/.test(lower) || lower === 'show all rows') return { type: 'reset' }
  if (/\b(hide empty|nonempty|non-empty)\b/.test(lower)) return { type: 'hideEmpty' }
  if (col < 0 || col >= columns) return { error: 'Please specify a valid column, such as A, B, or C.' }
  if (/\b(sort|order|rank)\b/.test(lower)) {
    const desc = /\b(desc|descending|highest|largest|biggest|z\s*to\s*a|high to low|decreasing)\b/.test(lower)
    return { type: 'sort', col, direction: desc ? 'desc' : 'asc' }
  }
  if (/\b(filter|find|show|contains?|search)\b/.test(lower)) {
    const term = query.match(/\b(?:for|containing|contains|equals|equal to|matching|with|is)\s+["']?(.+?)["']?\s*$/i)
    if (!term) return { error: 'Try: filter column A for Alice' }
    return { type: 'filter', col, term: term[1].trim().replace(/^["']|["']$/g, '') }
  }
  const aggregate = /\b(average|avg|mean)\b/.test(lower) ? 'average'
    : /\b(sum|total)\b/.test(lower) ? 'sum'
    : /\b(count|how many)\b/.test(lower) ? 'count'
    : /\b(minimum|min|smallest|lowest)\b/.test(lower) ? 'min'
    : /\b(maximum|max|largest|highest)\b/.test(lower) ? 'max' : null
  if (aggregate) return { type: 'aggregate', col, aggregate }
  return { error: 'Supported: sum, average, count, min, max, sort, filter, hide empty, and reset view.' }
}

// Display formatting never changes the underlying numeric value or formula.
function formatCellDisplay(value, format) {
  if (!format || format === 'general') return value
  const text = String(value ?? '')
  if (!text.trim() || !Number.isFinite(Number(text))) return value
  const number = Number(text)
  if (format === 'integer') return number.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (format === 'decimal') return number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (format === 'currency') return number.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  if (format === 'percent') return number.toLocaleString('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return value
}

export default function App() {
  // Engine instance is created once and reused across renders
  // Note: The engine maintains its own internal state, so React state is only used for UI updates
  const [engine] = useState(() => createEngine(TOTAL_ROWS, TOTAL_COLS))
  const [version, setVersion] = useState(0)
  const [selectedCell, setSelectedCell] = useState(null)
  const [selectionEnd, setSelectionEnd] = useState(null)
  const isDraggingRef = useRef(false)
  const fillDragRef = useRef(null)
  const [fillTarget, setFillTarget] = useState(null)
  const [editingCell, setEditingCell] = useState(null)
  const [editValue, setEditValue] = useState('')
  // Cell styles are stored separately from engine data
  // Format: { "row,col": { bold: bool, italic: bool, ... } }
  const [cellStyles, setCellStyles] = useState({})
  const cellInputRef = useRef(null)
  // Challenge 2: sorting and filtering are non-destructive views.
  // Physical cell coordinates, formulas and styles remain unchanged.
  const [sortColumn, setSortColumn] = useState(0)
  const [sortDirection, setSortDirection] = useState('none')
  const [filterColumn, setFilterColumn] = useState(0)
  const [filterText, setFilterText] = useState('')
  const [hideEmpty, setHideEmpty] = useState(false)
  const gridScrollRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(560)
  const [queryText, setQueryText] = useState('')
  const [queryResult, setQueryResult] = useState('Try "sum column B" or "filter column A for Alice".')


  const forceRerender = useCallback(() => setVersion(v => v + 1), [])

  // ────── Cell style helpers ──────

  const getCellStyle = useCallback((row, col) => {
    const key = `${row},${col}`
    return cellStyles[key] || {
      bold: false, italic: false, underline: false,
      bg: 'white', color: '#202124', align: 'left', fontSize: 13
    }
  }, [cellStyles])

  const updateCellStyle = useCallback((row, col, updates) => {
    const key = `${row},${col}`
    setCellStyles(prev => ({
      ...prev,
      [key]: { ...getCellStyle(row, col), ...updates }
    }))
  }, [getCellStyle])

  // ────── Cell editing ──────

  const startEditing = useCallback((row, col) => {
    setSelectedCell({ r: row, c: col })
    setEditingCell({ r: row, c: col })
    const cellData = engine.getCell(row, col)
    setEditValue(cellData.raw)
    setTimeout(() => cellInputRef.current?.focus(), 0)
  }, [engine])

  const commitEdit = useCallback((row, col) => {
    // Only commit if the value actually changed to avoid unnecessary recalculations
    const currentCell = engine.getCell(row, col)
    if (currentCell.raw !== editValue) {
      engine.setCell(row, col, editValue)
      forceRerender()
    }
    setEditingCell(null)
  }, [engine, editValue, forceRerender])

  const handleCellClick = useCallback((row, col, shiftKey = false) => {
    if (editingCell) commitEdit(editingCell.r, editingCell.c)

    if (shiftKey && selectedCell) {
      setSelectionEnd({ r: row, c: col })
    } else {
      setSelectedCell({ r: row, c: col })
      setSelectionEnd({ r: row, c: col })
    }
    setEditingCell(null)
  }, [editingCell, commitEdit, selectedCell])

  const handleCellDoubleClick = useCallback((row, col) => {
    setSelectionEnd({ r: row, c: col })
    startEditing(row, col)
  }, [startEditing])

  const handleCellMouseEnter = useCallback((row, col) => {
    if (fillDragRef.current) {
      fillDragRef.current.target = { r: row, c: col }
      setFillTarget({ r: row, c: col })
    } else if (isDraggingRef.current) setSelectionEnd({ r: row, c: col })
  }, [])

  const handleCellMouseUp = useCallback(() => {
    isDraggingRef.current = false
  }, [])

  // ────── Keyboard navigation ──────

  const handleKeyDown = useCallback((event, row, col) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(Math.min(row + 1, engine.rows - 1), col)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(row, Math.min(col + 1, engine.cols - 1))
    } else if (event.key === 'Escape') {
      setEditValue(engine.getCell(row, col).raw)
      setEditingCell(null)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(Math.min(row + 1, engine.rows - 1), col)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(Math.max(row - 1, 0), col)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      commitEdit(row, col)
      if (col > 0) {
        startEditing(row, col - 1)
      } else if (row > 0) {
        startEditing(row - 1, engine.cols - 1)
      }
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(row, Math.min(col + 1, engine.cols - 1))
    }
  }, [engine, commitEdit, startEditing])

  // ────── Formula bar handlers ──────

  const handleFormulaBarKeyDown = useCallback((event) => {
    if (!editingCell) return
    handleKeyDown(event, editingCell.r, editingCell.c)
  }, [editingCell, handleKeyDown])

  const handleFormulaBarFocus = useCallback(() => {
    if (selectedCell && !editingCell) {
      setEditingCell(selectedCell)
      setEditValue(engine.getCell(selectedCell.r, selectedCell.c).raw)
    }
  }, [selectedCell, editingCell, engine])

  const handleFormulaBarChange = useCallback((value) => {
    if (!editingCell && selectedCell) setEditingCell(selectedCell)
    setEditValue(value)
  }, [editingCell, selectedCell])

  // ────── Undo / Redo ──────

  const handleUndo = useCallback(() => { if (engine.undo()) forceRerender() }, [engine, forceRerender])
  const handleRedo = useCallback(() => { if (engine.redo()) forceRerender() }, [engine, forceRerender])

  // ────── Formatting toggles ──────

  const toggleBold = useCallback(() => {
    if (!selectedCell) return
    const style = getCellStyle(selectedCell.r, selectedCell.c)
    updateCellStyle(selectedCell.r, selectedCell.c, { bold: !style.bold })
  }, [selectedCell, getCellStyle, updateCellStyle])

  const toggleItalic = useCallback(() => {
    if (!selectedCell) return
    const style = getCellStyle(selectedCell.r, selectedCell.c)
    updateCellStyle(selectedCell.r, selectedCell.c, { italic: !style.italic })
  }, [selectedCell, getCellStyle, updateCellStyle])

  const toggleUnderline = useCallback(() => {
    if (!selectedCell) return
    const style = getCellStyle(selectedCell.r, selectedCell.c)
    updateCellStyle(selectedCell.r, selectedCell.c, { underline: !style.underline })
  }, [selectedCell, getCellStyle, updateCellStyle])

  const changeFontSize = useCallback((size) => {
    if (!selectedCell) return
    updateCellStyle(selectedCell.r, selectedCell.c, { fontSize: size })
  }, [selectedCell, updateCellStyle])

  const changeAlignment = useCallback((align) => {
    if (!selectedCell) return
    updateCellStyle(selectedCell.r, selectedCell.c, { align })
  }, [selectedCell, updateCellStyle])

  const changeFontColor = useCallback((color) => {
    if (!selectedCell) return
    updateCellStyle(selectedCell.r, selectedCell.c, { color })
  }, [selectedCell, updateCellStyle])

  const changeBackgroundColor = useCallback((color) => {
    if (!selectedCell) return
    updateCellStyle(selectedCell.r, selectedCell.c, { bg: color })
  }, [selectedCell, updateCellStyle])

  // ────── Clear operations ──────

  const clearSelectedCell = useCallback(() => {
    if (!selectedCell) return
    engine.setCell(selectedCell.r, selectedCell.c, '')
    forceRerender()
    // Remove style entry for cleared cell
    // Note: This deletes the style object entirely - if you need to preserve default styles,
    // you may want to set them explicitly rather than deleting
    const key = `${selectedCell.r},${selectedCell.c}`
    setCellStyles(prev => { const next = { ...prev }; delete next[key]; return next })
    setEditValue('')
  }, [selectedCell, engine, forceRerender])

  const clearAllCells = useCallback(() => {
    for (let r = 0; r < engine.rows; r++) {
      for (let c = 0; c < engine.cols; c++) {
        engine.setCell(r, c, '')
      }
    }
    forceRerender()
    setCellStyles({})
    setSelectedCell(null)
    setSelectionEnd(null)
    setEditingCell(null)
    setEditValue('')
  }, [engine, forceRerender])

  // ────── Sample data (fixtures/sales.tsv) ──────

  const loadSample = useCallback((loader) => {
    loader(engine)
    forceRerender()
    setSelectedCell({ r: 0, c: 0 })
    setSelectionEnd({ r: 0, c: 0 })
    setEditingCell(null)
    setEditValue('')
  }, [engine, forceRerender])

  // ────── Row / Column operations ──────

  const insertRow = useCallback(() => {
    if (!selectedCell) return
    engine.insertRow(selectedCell.r)
    forceRerender()
    setSelectedCell({ r: selectedCell.r + 1, c: selectedCell.c })
  }, [selectedCell, engine, forceRerender])

  const deleteRow = useCallback(() => {
    if (!selectedCell) return
    engine.deleteRow(selectedCell.r)
    forceRerender()
    if (selectedCell.r >= engine.rows) {
      setSelectedCell({ r: engine.rows - 1, c: selectedCell.c })
    }
  }, [selectedCell, engine, forceRerender])

  const insertColumn = useCallback(() => {
    if (!selectedCell) return
    engine.insertColumn(selectedCell.c)
    forceRerender()
    setSelectedCell({ r: selectedCell.r, c: selectedCell.c + 1 })
  }, [selectedCell, engine, forceRerender])

  const deleteColumn = useCallback(() => {
    if (!selectedCell) return
    engine.deleteColumn(selectedCell.c)
    forceRerender()
    if (selectedCell.c >= engine.cols) {
      setSelectedCell({ r: selectedCell.r, c: engine.cols - 1 })
    }
  }, [selectedCell, engine, forceRerender])

  // ────── Derived state ──────

  const selectionBounds = useMemo(() => {
    if (!selectedCell) return null
    const end = selectionEnd || selectedCell
    return {
      minRow: Math.min(selectedCell.r, end.r),
      maxRow: Math.max(selectedCell.r, end.r),
      minCol: Math.min(selectedCell.c, end.c),
      maxCol: Math.max(selectedCell.c, end.c),
    }
  }, [selectedCell, selectionEnd])

  // Challenge 5: Apply formatting to every cell in the selected rectangle.
  // Keep the existing style attributes while changing only the requested ones.
  const applyRangeStyle = useCallback((updates) => {
    if (!selectionBounds) return
    setCellStyles(previous => {
      const next = { ...previous }
      for (let r = selectionBounds.minRow; r <= selectionBounds.maxRow; r++) {
        for (let c = selectionBounds.minCol; c <= selectionBounds.maxCol; c++) {
          const key = `${r},${c}`
          next[key] = { ...previous[key], ...updates }
        }
      }
      return next
    })
  }, [selectionBounds])

  const clearRangeFormatting = useCallback(() => {
    if (!selectionBounds) return
    setCellStyles(previous => {
      const next = { ...previous }
      for (let r = selectionBounds.minRow; r <= selectionBounds.maxRow; r++) {
        for (let c = selectionBounds.minCol; c <= selectionBounds.maxCol; c++) {
          delete next[`${r},${c}`]
        }
      }
      return next
    })
  }, [selectionBounds])

  const finishFill = useCallback(() => {
    const drag = fillDragRef.current
    fillDragRef.current = null
    setFillTarget(null)
    isDraggingRef.current = false
    if (!drag) return
    const { bounds, target } = drag
    if (!target || target.r <= bounds.maxRow || target.c < bounds.minCol || target.c > bounds.maxCol) return
    const changes = []
    const styleUpdates = {}
    for (let c = bounds.minCol; c <= bounds.maxCol; c++) {
      const seeds = []
      for (let r = bounds.minRow; r <= bounds.maxRow; r++) seeds.push(engine.getCell(r, c).raw)
      const seedCount = seeds.length
      for (let r = bounds.maxRow + 1; r <= target.r; r++) {
        const index = r - bounds.minRow
        const seedIndex = (index % seedCount)
        const sourceRow = bounds.minRow + seedIndex
        const raw = seeds[seedIndex]
        const value = raw.startsWith('=')
          ? shiftFillFormula(raw, r - sourceRow, 0)
          : extendFillValue(seeds, index)
        changes.push({ row: r, col: c, value })
        const sourceStyle = cellStyles[`${sourceRow},${c}`]
        if (sourceStyle) styleUpdates[`${r},${c}`] = { ...sourceStyle }
      }
    }
    engine.ensureCapacity(target.r + 1, engine.cols)
    engine.setCells(changes)
    if (Object.keys(styleUpdates).length) setCellStyles(prev => ({ ...prev, ...styleUpdates }))
    setSelectedCell({ r: bounds.minRow, c: bounds.minCol })
    setSelectionEnd({ r: target.r, c: bounds.maxCol })
    forceRerender()
  }, [engine, cellStyles, forceRerender])

  // Capture mouse release even when the pointer leaves the grid.
  // React's grid onMouseUp alone can miss the end of a fill drag.
  const finishFillRef = useRef(finishFill)
  useEffect(() => { finishFillRef.current = finishFill }, [finishFill])
  useEffect(() => {
    const onGlobalMouseUp = () => {
      isDraggingRef.current = false
      if (fillDragRef.current) finishFillRef.current()
    }
    window.addEventListener('mouseup', onGlobalMouseUp)
    return () => window.removeEventListener('mouseup', onGlobalMouseUp)
  }, [])

  const visibleRows = useMemo(() => {
    const rows = Array.from({ length: engine.rows }, (_, r) => r)
    const valueAt = (r, c) => {
      const cell = engine.getCell(r, c)
      return String(cell.error ?? cell.computed ?? cell.raw ?? '')
    }
    const needle = filterText.trim().toLocaleLowerCase()
    const filtered = rows.filter(r => {
      if (needle && !valueAt(r, filterColumn).toLocaleLowerCase().includes(needle)) return false
      if (hideEmpty && !Array.from({ length: engine.cols }, (_, c) => engine.getCell(r, c).raw).some(Boolean)) return false
      return true
    })
    if (sortDirection !== 'none') {
      filtered.sort((a, b) => {
        const x = valueAt(a, sortColumn).trim()
        const y = valueAt(b, sortColumn).trim()
        if (!x && !y) return a - b
        if (!x) return 1
        if (!y) return -1
        const xn = Number(x), yn = Number(y)
        const cmp = x !== '' && y !== '' && Number.isFinite(xn) && Number.isFinite(yn)
          ? xn - yn
          : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' })
        return (sortDirection === 'asc' ? cmp : -cmp) || a - b
      })
    }
    return filtered
  }, [engine, version, sortColumn, sortDirection, filterColumn, filterText, hideEmpty])

  // Challenge 3: Only mount rows intersecting the viewport plus overscan.
  // Preserve their original engine row IDs so formulas and edits stay correct.
  useEffect(() => {
    const element = gridScrollRef.current
    if (!element) return
    const measure = () => setViewportHeight(element.clientHeight || 560)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = gridScrollRef.current
    if (element) element.scrollTop = 0
    setScrollTop(0)
  }, [sortColumn, sortDirection, filterColumn, filterText, hideEmpty])

  const firstVisibleIndex = Math.min(
    visibleRows.length,
    Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN)
  )
  const lastVisibleIndex = Math.min(
    visibleRows.length,
    Math.ceil((scrollTop + viewportHeight) / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN
  )
  const renderedRows = visibleRows.slice(firstVisibleIndex, lastVisibleIndex)
  const topSpacerHeight = firstVisibleIndex * VIRTUAL_ROW_HEIGHT
  const bottomSpacerHeight = (visibleRows.length - lastVisibleIndex) * VIRTUAL_ROW_HEIGHT

  const runSheetQuery = useCallback((event) => {
    event.preventDefault()
    const command = interpretSheetQuery(queryText, engine.cols)
    if (command.error) { setQueryResult(command.error); return }
    if (command.type === 'reset') {
      setSortDirection('none'); setFilterText(''); setHideEmpty(false)
      setQueryResult('View reset. All rows are visible in their original order.')
      return
    }
    if (command.type === 'hideEmpty') {
      setHideEmpty(true)
      setQueryResult('Empty rows are now hidden. Use "reset view" to restore them.')
      return
    }
    const label = (() => { let n = command.col + 1, out = ''; while (n) { n--; out = String.fromCharCode(65 + n % 26) + out; n = Math.floor(n / 26) } return out })()
    if (command.type === 'sort') {
      setSortColumn(command.col); setSortDirection(command.direction)
      setQueryResult(`Sorted the display by column ${label} (${command.direction === 'asc' ? 'ascending' : 'descending'}). Cell positions are unchanged.`)
      return
    }
    if (command.type === 'filter') {
      setFilterColumn(command.col); setFilterText(command.term)
      setQueryResult(`Showing rows where column ${label} contains "${command.term}".`)
      return
    }
    if (command.type === 'aggregate') {
      // Calculate against rows in the current view, ignoring blanks and nonnumeric values.
      const cells = visibleRows.map(r => engine.getCell(r, command.col))
      const nonblank = cells.map(c => String(c.error ?? c.computed ?? c.raw ?? '').trim()).filter(Boolean)
      const numeric = nonblank.map(Number).filter(Number.isFinite)
      const values = numeric
      let result
      if (command.aggregate === 'count') result = nonblank.length
      else if (!values.length) { setQueryResult(`No numeric values found in column ${label} within the current view.`); return }
      else if (command.aggregate === 'sum') result = values.reduce((a,b) => a+b, 0)
      else if (command.aggregate === 'average') result = values.reduce((a,b) => a+b, 0) / values.length
      else if (command.aggregate === 'min') result = Math.min(...values)
      else result = Math.max(...values)
      setQueryResult(`${command.aggregate.toUpperCase()} of column ${label}: ${Number(result.toPrecision(12)).toLocaleString()} (${command.aggregate === 'count' ? nonblank.length + ' nonempty cells' : numeric.length + ' numeric cells'} in the current view).`)
    }
  }, [queryText, engine, visibleRows])

  const viewIsModified = sortDirection !== 'none' || filterText.trim() !== '' || hideEmpty
  const resetView = () => {
    setSortDirection('none')
    setFilterText('')
    setHideEmpty(false)
  }

  const selectedCellStyle = useMemo(() => {
    return selectedCell ? getCellStyle(selectedCell.r, selectedCell.c) : null
  }, [selectedCell, getCellStyle])

  const getColumnLabel = useCallback((col) => {
    let label = ''
    let num = col + 1
    while (num > 0) {
      num--
      label = String.fromCharCode(65 + (num % 26)) + label
      num = Math.floor(num / 26)
    }
    return label
  }, [])

  const selectedCellLabel = selectedCell
    ? `${getColumnLabel(selectedCell.c)}${selectedCell.r + 1}`
    : 'No cell'

  // Formula bar shows the raw formula text, not the computed value
  // When editing, show the current editValue; otherwise show the cell's raw content
  // Note: This is different from the cell display, which shows computed values
  const formulaBarValue = editingCell
    ? editValue
    : (selectedCell ? engine.getCell(selectedCell.r, selectedCell.c).raw : '')

  // ────── Render ──────

  return (
    <div className="app-wrapper">
      <div className="app-header">
        <h2 className="app-title">📊 Spreadsheet App</h2>
      </div>

      <div className="main-content">

        {/* ── Toolbar ── */}
        <div className="toolbar">
          <div className="toolbar-group">
            <button className={`toolbar-btn bold-btn ${selectedCellStyle?.bold ? 'active' : ''}`} onClick={toggleBold} title="Bold">B</button>
            <button className={`toolbar-btn italic-btn ${selectedCellStyle?.italic ? 'active' : ''}`} onClick={toggleItalic} title="Italic">I</button>
            <button className={`toolbar-btn underline-btn ${selectedCellStyle?.underline ? 'active' : ''}`} onClick={toggleUnderline} title="Underline">U</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Size:</span>
            <select className="toolbar-select" value={selectedCellStyle?.fontSize || 13} onChange={(e) => changeFontSize(parseInt(e.target.value))}>
              {[8, 10, 11, 12, 13, 14, 16, 18, 20, 24].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="toolbar-group">
            <button className={`align-btn ${selectedCellStyle?.align === 'left' ? 'active' : ''}`} onClick={() => changeAlignment('left')} title="Align Left">⬤←</button>
            <button className={`align-btn ${selectedCellStyle?.align === 'center' ? 'active' : ''}`} onClick={() => changeAlignment('center')} title="Align Center">⬤</button>
            <button className={`align-btn ${selectedCellStyle?.align === 'right' ? 'active' : ''}`} onClick={() => changeAlignment('right')} title="Align Right">⬤→</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Text:</span>
            <input
              type="color"
              value={selectedCellStyle?.color || '#000000'}
              onChange={(e) => changeFontColor(e.target.value)}
              title="Font color"
              style={{ width: '32px', height: '32px', border: '1px solid #dadce0', cursor: 'pointer', borderRadius: '4px' }}
            />
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Fill:</span>
            <select className="toolbar-select" value={selectedCellStyle?.bg || 'white'} onChange={(e) => changeBackgroundColor(e.target.value)}>
              <option value="white">White</option>
              <option value="#ffff99">Yellow</option>
              <option value="#99ffcc">Green</option>
              <option value="#ffcccc">Red</option>
              <option value="#cce5ff">Blue</option>
              <option value="#e0ccff">Purple</option>
              <option value="#ffd9b3">Orange</option>
              <option value="#f0f0f0">Gray</option>
            </select>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={handleUndo} disabled={!engine.canUndo()} title="Undo">↶ Undo</button>
            <button className="toolbar-btn" onClick={handleRedo} disabled={!engine.canRedo()} title="Redo">↷ Redo</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={insertRow} title="Insert Row">+ Row</button>
            <button className="toolbar-btn" onClick={deleteRow} title="Delete Row">- Row</button>
            <button className="toolbar-btn" onClick={insertColumn} title="Insert Column">+ Col</button>
            <button className="toolbar-btn" onClick={deleteColumn} title="Delete Column">- Col</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn danger" onClick={clearSelectedCell}>✕ Cell</button>
            <button className="toolbar-btn danger" onClick={clearAllCells}>✕ All</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={() => loadSample(loadSampleSmall)} title="Load fixtures/sales.tsv (33 rows) at A1">⬇ Sample 33</button>
            <button className="toolbar-btn" onClick={() => loadSample(loadSampleLarge)} title="Load fixtures/sales-large.tsv (~3,000 rows) at A1">⬇ Sample 3k</button>
          </div>
        </div>

        {/* ── Challenge 5: range formatting and numeric display formats ── */}
        <div aria-label="Range formatting" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#f8fafc', borderBottom: '1px solid #cbd5e1', fontSize: 13 }}>
          <strong>Format Selection</strong>
          <span style={{ color: '#64748b' }}>Select cells first; changes apply to the whole range.</span>
          <label>Number format{' '}
            <select aria-label="Number format" value={selectedCellStyle?.numberFormat || 'general'} disabled={!selectedCell} onChange={e => applyRangeStyle({ numberFormat: e.target.value })}>
              <option value="general">General</option>
              <option value="integer">Number (0 decimals)</option>
              <option value="decimal">Number (2 decimals)</option>
              <option value="currency">Currency (USD)</option>
              <option value="percent">Percentage</option>
            </select>
          </label>
          <label>Border{' '}
            <select aria-label="Cell borders" value={selectedCellStyle?.border || 'none'} disabled={!selectedCell} onChange={e => applyRangeStyle({ border: e.target.value })}>
              <option value="none">None</option>
              <option value="all">All borders</option>
              <option value="bottom">Bottom border</option>
              <option value="top">Top border</option>
            </select>
          </label>
          <button className="toolbar-btn" disabled={!selectedCell} onClick={() => applyRangeStyle({ bold: true })}>Bold range</button>
          <button className="toolbar-btn" disabled={!selectedCell} onClick={() => applyRangeStyle({ bg: '#fff2b3' })}>Highlight range</button>
          <button className="toolbar-btn" disabled={!selectedCell} onClick={clearRangeFormatting}>Clear formatting</button>
        </div>

        {/* ── Challenge 2: Sort and filter (non-destructive view) ── */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, padding: '10px 12px', background: '#f1f5f9', borderBottom: '1px solid #d1d5db', fontSize: 13 }}>
          <strong>Sort &amp; Filter</strong>
          <label>Sort column{' '}
            <select aria-label="Sort column" value={sortColumn} onChange={e => setSortColumn(Number(e.target.value))}>
              {Array.from({ length: engine.cols }, (_, c) => <option key={c} value={c}>{getColumnLabel(c)}</option>)}
            </select>
          </label>
          <button className="toolbar-btn" onClick={() => setSortDirection('asc')}>A → Z / Small → Large</button>
          <button className="toolbar-btn" onClick={() => setSortDirection('desc')}>Z → A / Large → Small</button>
          <label>Filter column{' '}
            <select aria-label="Filter column" value={filterColumn} onChange={e => setFilterColumn(Number(e.target.value))}>
              {Array.from({ length: engine.cols }, (_, c) => <option key={c} value={c}>{getColumnLabel(c)}</option>)}
            </select>
          </label>
          <input aria-label="Filter text" placeholder="Contains text…" value={filterText} onChange={e => setFilterText(e.target.value)} style={{ padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 4, width: 145 }} />
          <label><input type="checkbox" checked={hideEmpty} onChange={e => setHideEmpty(e.target.checked)} /> Hide empty rows</label>
          <button className="toolbar-btn" onClick={resetView}>Reset view</button>
          <span style={{ color: '#475569' }}>{visibleRows.length} of {engine.rows} rows · {renderedRows.length} mounted</span>
          {viewIsModified && <span style={{ color: '#9a3412' }}>View only · Reset view to use fill handle</span>}
        </div>

        {/* ── Challenge 4: local natural-language spreadsheet commands ── */}
        <form onSubmit={runSheetQuery} aria-label="Spreadsheet natural language queries" style={{ padding: '12px', background: '#eff6ff', borderBottom: '1px solid #bfdbfe' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <strong>Ask the Sheet</strong>
            <span style={{ color: '#475569', fontSize: 12 }}>Local command parser · no AI API required</span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input aria-label="Ask the Sheet query" value={queryText} onChange={e => setQueryText(e.target.value)} placeholder="e.g. average column B, sort column C descending" style={{ flex: 1, minWidth: 0, padding: '8px 10px', border: '1px solid #93c5fd', borderRadius: 5 }} />
            <button type="submit" className="toolbar-btn">Run query</button>
          </div>
          <div role="status" aria-live="polite" style={{ marginTop: 7, fontSize: 13, color: '#1e3a8a' }}>{queryResult}</div>
        </form>

        {/* ── Formula Bar ── */}
        <div className="formula-bar">
          <span className="formula-bar-label">{selectedCellLabel}</span>
          <input
            className="formula-bar-input"
            value={formulaBarValue}
            onChange={(e) => handleFormulaBarChange(e.target.value)}
            onKeyDown={handleFormulaBarKeyDown}
            onFocus={handleFormulaBarFocus}
            placeholder="Select a cell then type, or enter a formula like =SUM(A1:A5)"
          />
        </div>

        {/* ── Grid ── */}
        <div className="grid-scroll" ref={gridScrollRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} onMouseUp={() => { handleCellMouseUp(); finishFill() }} onMouseLeave={handleCellMouseUp} style={{ height: 'min(62vh, 620px)', overflow: 'auto' }}>
          <table className="grid-table">
            <thead>
              <tr>
                <th className="col-header-blank"></th>
                {Array.from({ length: engine.cols }, (_, colIndex) => (
                  <th key={colIndex} className="col-header">
                    {getColumnLabel(colIndex)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topSpacerHeight > 0 && (
                <tr aria-hidden="true" style={{ height: topSpacerHeight }}>
                  <td colSpan={engine.cols + 1} style={{ height: topSpacerHeight, padding: 0, border: 0, background: 'transparent' }} />
                </tr>
              )}
              {renderedRows.map(rowIndex => (
                <tr key={rowIndex} style={{ height: VIRTUAL_ROW_HEIGHT }}>
                  <td className="row-header">{rowIndex + 1}</td>
                  {Array.from({ length: engine.cols }, (_, colIndex) => {
                    const isSelected = Boolean(selectionBounds &&
                      rowIndex >= selectionBounds.minRow &&
                      rowIndex <= selectionBounds.maxRow &&
                      colIndex >= selectionBounds.minCol &&
                      colIndex <= selectionBounds.maxCol)
                    const isEditing = editingCell?.r === rowIndex && editingCell?.c === colIndex
                    const cellData = engine.getCell(rowIndex, colIndex)
                    const style = cellStyles[`${rowIndex},${colIndex}`] || {}
                    const displayValue = cellData.error
                      ? cellData.error
                      : (cellData.computed !== null && cellData.computed !== '' ? String(cellData.computed) : cellData.raw)

                    return (
                      <td
                        key={colIndex}
                        className={`cell ${isSelected ? 'selected' : ''} ${fillTarget && selectionBounds && colIndex >= selectionBounds.minCol && colIndex <= selectionBounds.maxCol && rowIndex > selectionBounds.maxRow && rowIndex <= fillTarget.r ? 'selected' : ''}`}
                        style={{ background: style.bg || 'white', position: 'relative', boxShadow: style.border === 'all' ? 'inset 0 0 0 1px #64748b' : style.border === 'bottom' ? 'inset 0 -2px 0 #64748b' : style.border === 'top' ? 'inset 0 2px 0 #64748b' : undefined }}
                        onMouseDown={(e) => {
                          if (e.target.tagName === 'INPUT') return
                          e.preventDefault()
                          if (fillDragRef.current) return
                          isDraggingRef.current = true
                          handleCellClick(rowIndex, colIndex, e.shiftKey)
                        }}
                        onMouseEnter={() => handleCellMouseEnter(rowIndex, colIndex)}
                        onMouseUp={handleCellMouseUp}
                        onDoubleClick={() => handleCellDoubleClick(rowIndex, colIndex)}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            className="cell-input"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => commitEdit(rowIndex, colIndex)}
                            onKeyDown={(e) => handleKeyDown(e, rowIndex, colIndex)}
                            ref={editingCell?.r === rowIndex && editingCell?.c === colIndex ? cellInputRef : undefined}
                            style={{
                              fontWeight: style.bold ? 'bold' : 'normal',
                              fontStyle: style.italic ? 'italic' : 'normal',
                              textDecoration: style.underline ? 'underline' : 'none',
                              color: style.color || '#202124',
                              fontSize: (style.fontSize || 13) + 'px',
                              textAlign: style.align || 'left',
                              background: style.bg || 'white',
                            }}
                          />
                        ) : (
                          <div
                            className={`cell-display align-${style.align || 'left'} ${cellData.error ? 'error' : ''}`}
                            style={{
                              fontWeight: style.bold ? 'bold' : 'normal',
                              fontStyle: style.italic ? 'italic' : 'normal',
                              textDecoration: style.underline ? 'underline' : 'none',
                              color: cellData.error ? '#d93025' : (style.color || '#202124'),
                              fontSize: (style.fontSize || 13) + 'px',
                            }}
                          >
                            {cellData.error ? displayValue : formatCellDisplay(displayValue, style.numberFormat)}
                          </div>
                        )}
                        {!viewIsModified && isSelected && selectionBounds && rowIndex === selectionBounds.maxRow && colIndex === selectionBounds.maxCol && !isEditing && (
                          <span
                            title="Drag down to fill cells"
                            onMouseDown={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              isDraggingRef.current = false
                              fillDragRef.current = { bounds: { ...selectionBounds }, target: { r: rowIndex, c: colIndex } }
                            }}
                            style={{ position: 'absolute', width: 9, height: 9, right: -4, bottom: -4, background: '#1a73e8', border: '1px solid white', cursor: 'crosshair', zIndex: 5 }}
                          />
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
              {bottomSpacerHeight > 0 && (
                <tr aria-hidden="true" style={{ height: bottomSpacerHeight }}>
                  <td colSpan={engine.cols + 1} style={{ height: bottomSpacerHeight, padding: 0, border: 0, background: 'transparent' }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="footer-hint">
          Click to select · Double-click to edit · Drag blue square down to fill (normal view) · Sort/filter changes the display order only · Formulas: =A1+B1 · =SUM(A1:A5) · =AVG(A1:A5) · =MAX(A1:A5) · =MIN(A1:A5)
        </p>
      </div>
    </div>
  )
}
