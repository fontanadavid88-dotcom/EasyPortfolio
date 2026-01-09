export const PAGE_WIDTH_MM = 210;
export const PAGE_HEIGHT_MM = 297;

export type Widget = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  type?: 'card' | 'text';
  locked?: boolean;
  props?: Record<string, unknown>;
  // text widget fields
  text?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  color?: string;
  bg?: string;
  border?: string;
};

export type PageLayout = {
  id: string;
  widgets: Widget[];
};

export type PageConfig = {
  marginMm: number;
  headerMm: number;
  footerMm?: number;
  orientation?: 'portrait' | 'landscape';
};

export type ReportSettings = {
  headerEnabled: boolean;
  footerEnabled: boolean;
  headerTitle: string;
  headerSubtitle: string;
  footerLeft: string;
  footerRightTemplate: string;
  logoDataUrl?: string;
  logoPosition: 'left' | 'right';
  logoSizeMm: number;
};

export type ReportLayout = {
  version: number;
  page: PageConfig;
  pages: PageLayout[];
  settings?: ReportSettings;
};

const DEFAULT_MIN_W = 25;
const DEFAULT_MIN_H = 20;
const DEFAULT_PAGE: PageConfig = { marginMm: 8, headerMm: 14, footerMm: 10, orientation: 'portrait' };
const DEFAULT_SETTINGS: ReportSettings = {
  headerEnabled: true,
  footerEnabled: true,
  headerTitle: 'Report Portafoglio',
  headerSubtitle: 'Generato automaticamente',
  footerLeft: 'EasyPortfolio',
  footerRightTemplate: 'Pagina {page}/{pages}',
  logoPosition: 'left',
  logoSizeMm: 12
};

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

const cleanNumber = (value: unknown, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

export const getCanvasSize = (page: PageConfig) => {
  const margin = page?.marginMm ?? DEFAULT_PAGE.marginMm;
  const header = page?.headerMm ?? DEFAULT_PAGE.headerMm;
  const footer = page?.footerMm ?? DEFAULT_PAGE.footerMm ?? 0;
  const orientation = page?.orientation ?? 'portrait';
  const pageW = orientation === 'landscape' ? PAGE_HEIGHT_MM : PAGE_WIDTH_MM;
  const pageH = orientation === 'landscape' ? PAGE_WIDTH_MM : PAGE_HEIGHT_MM;
  const canvasW = pageW - margin * 2;
  const canvasH = pageH - margin * 2 - header - footer;
  return { canvasW, canvasH, pageW, pageH, orientation };
};

export const validateLayout = (layout: ReportLayout): ReportLayout => {
  const pageCfg = layout?.page ?? DEFAULT_PAGE;
  const { canvasW, canvasH, orientation } = getCanvasSize(pageCfg);

  const pages = (layout?.pages || []).map(page => {
    const widgets = (page.widgets || []).map(w => {
      const minW = w.minW ?? DEFAULT_MIN_W;
      const minH = w.minH ?? DEFAULT_MIN_H;
      const x = cleanNumber(w.x);
      const y = cleanNumber(w.y);
      const width = Math.max(cleanNumber(w.w, minW), minW);
      const height = Math.max(cleanNumber(w.h, minH), minH);

      const clampedW = clamp(width, minW, canvasW);
      const clampedH = clamp(height, minH, canvasH);
      const clampedX = clamp(x, 0, Math.max(0, canvasW - clampedW));
      const clampedY = clamp(y, 0, Math.max(0, canvasH - clampedH));

      return {
        ...w,
        type: w.type ?? 'card',
        locked: w.locked ?? false,
        text: w.text ?? (w.type === 'text' ? 'Doppio click per modificare' : undefined),
        fontSize: w.fontSize ?? 12,
        bold: w.bold ?? false,
        italic: w.italic ?? false,
        align: w.align ?? 'left',
        color: w.color ?? '#0f172a',
        bg: w.bg ?? '#ffffff',
        border: w.border ?? '#e2e8f0',
        x: clampedX,
        y: clampedY,
        w: clampedW,
        h: clampedH,
        minW,
        minH
      };
    });
    return { ...page, widgets };
  });

  return {
    version: layout?.version ?? 1,
    page: {
      marginMm: pageCfg.marginMm ?? DEFAULT_PAGE.marginMm,
      headerMm: pageCfg.headerMm ?? DEFAULT_PAGE.headerMm,
      footerMm: pageCfg.footerMm ?? DEFAULT_PAGE.footerMm,
      orientation: orientation ?? 'portrait'
    },
    pages,
    settings: {
      ...DEFAULT_SETTINGS,
      ...(layout?.settings || {})
    }
  };
};

// Preset A (derivato dal layout precedente, ottimizzato per stare in A4)
export const presetA: ReportLayout = validateLayout({
  version: 2,
  page: { marginMm: 8, headerMm: 14, footerMm: 10, orientation: 'portrait' },
  pages: [
    {
      id: 'page-1',
      widgets: [
        { id: 'kpi', x: 0, y: 0, w: 130, h: 50, minW: 80, minH: 40 },
        { id: 'macro', x: 135, y: 0, w: 55, h: 50, minW: 45, minH: 40 },
        { id: 'trend', x: 0, y: 55, w: 190, h: 75, minW: 120, minH: 60 },
        { id: 'retann', x: 0, y: 135, w: 95, h: 55, minW: 70, minH: 40 },
        { id: 'dd', x: 100, y: 135, w: 90, h: 55, minW: 70, minH: 40 }
      ]
    },
    {
      id: 'page-2',
      widgets: [
        { id: 'composition', x: 0, y: 0, w: 90, h: 60, minW: 60, minH: 45 },
        { id: 'currency', x: 95, y: 0, w: 95, h: 60, minW: 60, minH: 45 },
        { id: 'regions', x: 0, y: 65, w: 190, h: 90, minW: 120, minH: 50 }
      ]
    }
  ]
});

// Preset B (variazione)
export const presetB: ReportLayout = validateLayout({
  version: 2,
  page: { marginMm: 8, headerMm: 14, footerMm: 10, orientation: 'portrait' },
  pages: [
    {
      id: 'page-1',
      widgets: [
        { id: 'kpi', x: 0, y: 0, w: 130, h: 50, minW: 80, minH: 40 },
        { id: 'macro', x: 135, y: 0, w: 55, h: 50, minW: 45, minH: 40 },
        { id: 'twrr', x: 0, y: 55, w: 190, h: 70, minW: 120, minH: 60 },
        { id: 'mwrr', x: 0, y: 130, w: 190, h: 70, minW: 120, minH: 60 }
      ]
    },
    {
      id: 'page-2',
      widgets: [
        { id: 'retann', x: 0, y: 0, w: 95, h: 55, minW: 70, minH: 40 },
        { id: 'dd', x: 100, y: 0, w: 90, h: 55, minW: 70, minH: 40 },
        { id: 'composition', x: 0, y: 60, w: 90, h: 60, minW: 60, minH: 45 },
        { id: 'currency', x: 95, y: 60, w: 95, h: 60, minW: 60, minH: 45 },
        { id: 'regions', x: 0, y: 125, w: 190, h: 90, minW: 120, minH: 50 }
      ]
    }
  ]
});
