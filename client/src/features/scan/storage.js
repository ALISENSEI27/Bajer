export const REPORTS_STORAGE_KEY = "bajer.scan.reports.v1";
export const REPORTS_VERSION = 1;
export const MAX_SAVED_REPORTS = 30;
const FIELD_KEYS = [
  "propertyType",
  "location",
  "price",
  "area",
  "bedrooms",
  "propertyAge",
  "ownership",
  "maintenanceFees",
];

export class ScanStorageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ScanStorageError";
    this.code = code;
  }
}

function isFieldsShape(fields) {
  return Boolean(
    fields &&
      FIELD_KEYS.every((key) => {
        const field = fields[key];
        return Boolean(
          field &&
            ["found", "missing", "unclear"].includes(field.status) &&
            Array.isArray(field.evidence) &&
            field.evidence.every((quote) => typeof quote === "string") &&
            (field.status === "found"
              ? typeof field.value === "string" && field.value.trim().length > 0
              : field.value === null),
        );
      }),
  );
}

function isAnalysisShape(analysis) {
  return Boolean(
    analysis &&
      ["demo", "ai"].includes(analysis.mode) &&
      typeof analysis.notice === "string" &&
      isFieldsShape(analysis.fields) &&
      Array.isArray(analysis.contradictions) &&
      analysis.contradictions.every(
        (item) =>
          item &&
          typeof item.field === "string" &&
          typeof item.message === "string" &&
          Array.isArray(item.evidence) &&
          item.evidence.every((quote) => typeof quote === "string"),
      ) &&
      Array.isArray(analysis.questions) &&
      analysis.questions.every((item) => typeof item === "string") &&
      Array.isArray(analysis.limitations) &&
      analysis.limitations.every((item) => typeof item === "string"),
  );
}

function isReportShape(report) {
  return Boolean(
    report &&
      typeof report.id === "string" &&
      report.id.length > 0 &&
      typeof report.originalText === "string" &&
      report.originalText.length >= 20 &&
      report.originalText.length <= 12000 &&
      isAnalysisShape(report.analysis) &&
      isFieldsShape(report.approvedFields) &&
      typeof report.approvedAt === "string" &&
      report.approvedAt.length > 0,
  );
}

function validateNewReport(report) {
  if (!isReportShape(report)) {
    throw new ScanStorageError(
      "لم يُحفظ التقرير لأن بياناته لا تطابق البنية المطلوبة.",
      "invalid-report",
    );
  }
}

function validateReports(value) {
  if (
    !value ||
    value.version !== REPORTS_VERSION ||
    !Array.isArray(value.reports) ||
    value.reports.length > MAX_SAVED_REPORTS ||
    value.reports.some((report) => !isReportShape(report))
  ) {
    throw new ScanStorageError(
      "تعذّر قراءة التقارير المحفوظة: البيانات غير صالحة. لم يتم تغيير التخزين.",
      "corrupt",
    );
  }
  return value.reports;
}

function readReports(storage) {
  let raw;
  try {
    raw = storage.getItem(REPORTS_STORAGE_KEY);
  } catch {
    throw new ScanStorageError(
      "التخزين المحلي غير متاح الآن. تحقق من إعدادات المتصفح ثم أعد المحاولة.",
      "unavailable",
    );
  }
  if (raw === null) return [];
  try {
    return validateReports(JSON.parse(raw));
  } catch (error) {
    if (error instanceof ScanStorageError) throw error;
    throw new ScanStorageError(
      "تعذّر قراءة التقارير المحفوظة: الملف تالف. لم يتم استبداله أو حذفه.",
      "corrupt",
    );
  }
}

function writeReports(storage, reports) {
  try {
    storage.setItem(
      REPORTS_STORAGE_KEY,
      JSON.stringify({ version: REPORTS_VERSION, reports }),
    );
  } catch (error) {
    const quota =
      error?.name === "QuotaExceededError" ||
      error?.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      error?.code === 22 ||
      error?.code === 1014;
    throw new ScanStorageError(
      quota
        ? "المساحة المحلية ممتلئة. احذف تقريراً قديماً أو حرّر مساحة ثم أعد الحفظ."
        : "تعذّر حفظ التقرير في التخزين المحلي. لم يتم تغيير التقارير السابقة.",
      quota ? "quota" : "unavailable",
    );
  }
}

export function listScanReports(storage) {
  if (!storage) {
    throw new ScanStorageError(
      "التخزين المحلي غير متاح في هذه البيئة.",
      "unavailable",
    );
  }
  return readReports(storage);
}

export function saveScanReport(report, storage) {
  if (!storage) {
    throw new ScanStorageError(
      "التخزين المحلي غير متاح في هذه البيئة.",
      "unavailable",
    );
  }
  validateNewReport(report);
  const current = readReports(storage);
  if (current.length >= MAX_SAVED_REPORTS) {
    throw new ScanStorageError(
      "وصلت إلى الحد الأقصى وهو 30 تقريراً. احذف تقريراً محفوظاً من القائمة قبل حفظ تقرير جديد.",
      "limit",
    );
  }
  const next = [report, ...current];
  writeReports(storage, next);
  return next;
}

export function deleteScanReport(id, storage) {
  if (!storage) {
    throw new ScanStorageError(
      "التخزين المحلي غير متاح في هذه البيئة.",
      "unavailable",
    );
  }
  const current = readReports(storage);
  const next = current.filter((report) => report.id !== id);
  if (next.length === current.length) return current;
  writeReports(storage, next);
  return next;
}
