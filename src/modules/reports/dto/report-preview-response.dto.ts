export type ReportPreviewReportType = 'finance' | 'appointments' | 'inventory' | 'invoices';

export interface ReportPreviewClinic {
  name: string;
  document: null;
}

export interface ReportPreviewFilter {
  label: string;
  value: string;
}

export interface ReportPreviewPeriod {
  startDate: string | null;
  endDate: string | null;
  label: string;
}

export interface ReportPreviewResponse {
  reportType: ReportPreviewReportType;
  reportTitle: string;
  clinic: ReportPreviewClinic;
  generatedAt: string;
  filters: ReportPreviewFilter[];
  period: ReportPreviewPeriod | null;
  recordCount: number;
  maxRecords: number;
  isTruncated: boolean;
  exportFormat: 'CSV';
  empty: boolean;
  previewNote: string | null;
}
