import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_SAVED_REPORTS,
  deleteScanReport,
  listScanReports,
  saveScanReport,
} from "./storage";
import "./scan.css";

const FIELD_DEFS = [
  ["propertyType", "نوع العقار"],
  ["location", "الموقع"],
  ["price", "السعر"],
  ["area", "المساحة"],
  ["bedrooms", "غرف النوم"],
  ["propertyAge", "عمر العقار"],
  ["ownership", "نوع الملكية"],
  ["maintenanceFees", "رسوم الصيانة"],
];

function copyFields(fields) {
  return Object.fromEntries(
    FIELD_DEFS.map(([key]) => {
      const field = fields?.[key] || {};
      return [
        key,
        {
          status: ["found", "missing", "unclear"].includes(field.status)
            ? field.status
            : "missing",
          value: field.status === "found" ? String(field.value ?? "") : null,
          evidence: Array.isArray(field.evidence)
            ? field.evidence.map((item) => String(item))
            : [],
        },
      ];
    }),
  );
}

function isFieldShape(field) {
  return Boolean(
    field &&
      ["found", "missing", "unclear"].includes(field.status) &&
      Array.isArray(field.evidence) &&
      field.evidence.every((item) => typeof item === "string") &&
      (field.status === "found"
        ? typeof field.value === "string" && field.value.trim().length > 0
        : field.value === null),
  );
}

function validateAnalysis(body) {
  if (
    !body ||
    !["demo", "ai"].includes(body.mode) ||
    typeof body.notice !== "string" ||
    !body.fields ||
    !Array.isArray(body.contradictions) ||
    !Array.isArray(body.questions) ||
    !body.questions.every((item) => typeof item === "string") ||
    !Array.isArray(body.limitations) ||
    !body.limitations.every((item) => typeof item === "string")
  ) {
    throw new Error("استجابة الخدمة غير مكتملة. أعد المحاولة بعد قليل.");
  }
  const fields = {};
  for (const [key] of FIELD_DEFS) {
    const field = body.fields[key];
    if (!isFieldShape(field)) {
      throw new Error("استجابة الخدمة لا تحتوي على بيانات مراجعة صالحة.");
    }
    fields[key] = {
      status: field.status,
      value: field.value,
      evidence: [...field.evidence],
    };
  }
  if (
    body.contradictions.some(
      (item) =>
        !item ||
        typeof item.field !== "string" ||
        typeof item.message !== "string" ||
        !Array.isArray(item.evidence) ||
        !item.evidence.every((quote) => typeof quote === "string"),
    )
  ) {
    throw new Error("استجابة الخدمة تحتوي على تعارضات غير صالحة.");
  }
  return {
    mode: body.mode,
    notice: body.notice,
    fields,
    contradictions: body.contradictions.map((item) => ({
      field: item.field,
      message: item.message,
      evidence: [...item.evidence],
    })),
    questions: [...body.questions],
    limitations: [...body.limitations],
  };
}

function getStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `scan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function statusLabel(status) {
  return {
    found: "مذكور في الإعلان",
    missing: "غير مذكور",
    unclear: "غير واضح",
  }[status];
}

export function Scan({ analyzeUrl = "/api/scan/analyze" }) {
  const [text, setText] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [editedFields, setEditedFields] = useState(null);
  const [approval, setApproval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedReports, setSavedReports] = useState([]);
  const [storageError, setStorageError] = useState("");
  const [activeSaved, setActiveSaved] = useState(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [approvalError, setApprovalError] = useState("");
  const [notice, setNotice] = useState("");
  const revision = useRef(0);
  const requestRef = useRef(null);

  const count = text.length;
  const canAnalyze = count >= 20 && count <= 12000 && !busy;
  const currentFields = editedFields || (analysis ? copyFields(analysis.fields) : null);
  const reportsLabel = useMemo(
    () => `${savedReports.length} من ${MAX_SAVED_REPORTS} تقريراً محفوظاً`,
    [savedReports.length],
  );

  useEffect(() => {
    try {
      setSavedReports(listScanReports(getStorage()));
      setStorageError("");
    } catch (reason) {
      setStorageError(reason.message);
    }
  }, []);

  useEffect(
    () => () => {
      requestRef.current?.abort();
    },
    [],
  );

  function updateText(value) {
    revision.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    setBusy(false);
    setText(value);
    setError("");
    setNotice("");
    setApproval(false);
    setApprovalError("");
    setActiveSaved(null);
    if (analysis) {
      setAnalysis(null);
      setEditedFields(null);
    }
  }

  async function analyze() {
    if (!canAnalyze) return;
    const submittedText = text;
    const submittedRevision = revision.current;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 25000);
    setBusy(true);
    setError("");
    setNotice("");
    setAnalysis(null);
    setEditedFields(null);
    setApproval(false);
    setApprovalError("");
    setActiveSaved(null);
    setDeleteConfirmId(null);
    try {
      const response = await fetch(analyzeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: submittedText }),
        signal: controller.signal,
      });
      if (requestRef.current !== controller) return;
      const raw = await response.text();
      if (requestRef.current !== controller) return;
      let body;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error("وصل رد غير قابل للقراءة من الخدمة. أعد المحاولة.");
      }
      if (!response.ok) {
        const serverMessage =
          typeof body?.error?.message === "string"
            ? body.error.message
            : typeof body?.message === "string"
              ? body.message
              : "";
        throw new Error(
          serverMessage || `تعذّر إكمال الفحص (رمز ${response.status}). أعد المحاولة.`,
        );
      }
      const result = validateAnalysis(body);
      if (requestRef.current !== controller) return;
      if (
        submittedRevision !== revision.current ||
        submittedText !== text
      ) {
        return;
      }
      setAnalysis(result);
      setEditedFields(copyFields(result.fields));
    } catch (reason) {
      if (
        requestRef.current !== controller ||
        submittedRevision !== revision.current
      ) return;
      if (reason?.name === "AbortError") {
        setError("انتهت مهلة الفحص أو أُوقف الطلب. أعد المحاولة.");
      } else {
        setError(reason?.message || "حدث خطأ غير متوقع أثناء الفحص.");
      }
    } finally {
      clearTimeout(timeout);
      if (
        requestRef.current === controller &&
        submittedRevision === revision.current
      ) setBusy(false);
    }
  }

  function editField(key, changes) {
    setEditedFields((previous) => {
      const next = { ...(previous || copyFields(analysis.fields)) };
      const updated = { ...next[key], ...changes };
      if (updated.status !== "found") updated.value = null;
      if (updated.status === "found" && updated.value === null) updated.value = "";
      next[key] = updated;
      return next;
    });
    setApproval(false);
    setApprovalError("");
    setNotice("تم تعديل البيانات. يلزم تأكيد المراجعة قبل حفظها.");
  }

  function openReport(report) {
    revision.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    setBusy(false);
    setText(report.originalText);
    setAnalysis(report.analysis);
    setEditedFields(copyFields(report.approvedFields));
    setApproval(false);
    setApprovalError("");
    setActiveSaved(report);
    setError("");
    setNotice("هذا تقرير محفوظ. البيانات المعتمدة سابقاً معروضة منفصلة عن نتيجة التحليل الأصلية.");
  }

  function saveReport() {
    if (!analysis || !currentFields || !approval || busy) return;
    const approvedFields = copyFields(currentFields);
    if (
      FIELD_DEFS.some(
        ([key]) =>
          approvedFields[key].status === "found" &&
          !approvedFields[key].value?.trim(),
      )
    ) {
      setApprovalError("أدخل قيمة لكل معلومة حالتها «مذكور في الإعلان» قبل الحفظ، أو غيّر حالتها.");
      return;
    }
    const report = {
      id: makeId(),
      originalText: text,
      analysis,
      approvedFields,
      approvedAt: new Date().toISOString(),
    };
    try {
      const next = saveScanReport(report, getStorage());
      setSavedReports(next);
      setActiveSaved(report);
      setStorageError("");
      setApprovalError("");
      setNotice("حُفظ التقرير محلياً مع بياناتك المعتمدة.");
      setApproval(false);
    } catch (reason) {
      setStorageError(reason.message);
    }
  }

  function deleteReport(reportId) {
    if (deleteConfirmId !== reportId) {
      setDeleteConfirmId(reportId);
      return;
    }
    try {
      const next = deleteScanReport(reportId, getStorage());
      setSavedReports(next);
      setDeleteConfirmId(null);
      setStorageError("");
      setNotice("حُذف التقرير المحدد من تخزين باجِر المحلي.");
      if (activeSaved?.id === reportId) setActiveSaved(null);
    } catch (reason) {
      setStorageError(reason.message);
    }
  }

  const originalFields = analysis ? copyFields(analysis.fields) : null;

  return (
    <main className="bajer-scan" dir="rtl">
      <div className="scan-shell">
        <header className="scan-header">
          <div className="scan-brand" aria-label="باجِر — مراجعة الإعلان">
            <span className="scan-brand-mark" aria-hidden="true">ب</span>
            <span><strong>باجِر</strong><small>مراجعة الإعلان</small></span>
          </div>
          <div className="scan-header-note">
            <span className="scan-live-dot" aria-hidden="true" />
            <span>اقرأ الإعلان. تحقّق من الدليل.</span>
          </div>
        </header>

        <section className="scan-intro" aria-labelledby="scan-title">
          <div className="scan-intro-copy">
            <p className="scan-eyebrow"><span>BAJER</span> / PROPERTY REVIEW</p>
            <h1 id="scan-title">لا تخمّن.<br /><em>افحص ما كُتب.</em></h1>
            <p className="scan-lede">الصق نص الإعلان العقاري، وسنرتّب ما ورد فيه إلى بيانات مذكورة مع اقتباساتها، ونقاط تحتاج إلى سؤال.</p>
          </div>
          <div className="scan-intro-art" aria-hidden="true">
            <div className="scan-art-orbit scan-orbit-one" />
            <div className="scan-art-orbit scan-orbit-two" />
            <div className="scan-art-sheet">
              <span className="scan-art-line scan-art-line-short" />
              <span className="scan-art-line" />
              <span className="scan-art-line scan-art-line-mid" />
              <span className="scan-art-highlight" />
              <span className="scan-art-check">✓</span>
            </div>
            <span className="scan-art-tag">النص ← الدليل</span>
          </div>
        </section>

        <section className="scan-workspace" aria-label="مساحة فحص الإعلان">
          <div className="scan-input-panel">
            <div className="scan-section-heading">
              <div>
                <span className="scan-step">01</span>
                <h2>نص الإعلان</h2>
              </div>
              <span className="scan-no-upload">نص فقط · لا صور أو ملفات PDF</span>
            </div>
            <label className="scan-sr-only" htmlFor="scan-ad-text">الصق نص الإعلان العقاري</label>
            <textarea
              id="scan-ad-text"
              data-testid="input-ad-text"
              className="scan-textarea"
              dir="auto"
              value={text}
              onChange={(event) => updateText(event.target.value)}
              placeholder="الصق هنا نص الإعلان كما هو، دون تعديل..."
              maxLength={12000}
              aria-describedby="scan-char-count scan-input-hint"
            />
            <div className="scan-input-footer">
              <p id="scan-input-hint">أزل أرقام التواصل أو البيانات الشخصية قبل اللصق.</p>
              <span
                id="scan-char-count"
                className={count > 12000 ? "is-over-limit" : ""}
                data-testid="text-character-count"
                aria-live="polite"
              >{count.toLocaleString("ar")} / ١٢٬٠٠٠</span>
            </div>
            <div className="scan-action-row">
              <button
                className="scan-primary-button"
                type="button"
                onClick={analyze}
                disabled={!canAnalyze}
                data-testid="button-analyze"
              >
                {busy ? <><span className="scan-button-pulse" /> جارٍ فحص النص</> : <>ابدأ الفحص <span aria-hidden="true">←</span></>}
              </button>
              <span className="scan-minimum-note">من ٢٠ إلى ١٢٬٠٠٠ حرف</span>
            </div>
            {error && <p className="scan-error" role="alert" data-testid="status-analysis-error">{error}</p>}
          </div>

          <aside className="scan-saved-panel" aria-labelledby="saved-title">
            <div className="scan-saved-top">
              <div className="scan-saved-icon" aria-hidden="true">↗</div>
              <div><h2 id="saved-title">تقاريرك</h2><p data-testid="text-saved-count">{reportsLabel}</p></div>
            </div>
            <p className="scan-saved-desc">تُحفظ التقارير كنص عادي في هذا المتصفح، وهي مشتركة مع مستخدمي المتصفح نفسه على هذا النطاق. لا تُحفظ في حساب أو على الخادم.</p>
            {storageError && <p className="scan-error scan-storage-error" role="alert" data-testid="status-storage-error">{storageError}</p>}
            {savedReports.length ? (
              <ul className="scan-report-list">
                {savedReports.map((report) => (
                  <li key={report.id}>
                    <button
                      className={`scan-report-item${activeSaved?.id === report.id ? " is-active" : ""}`}
                      type="button"
                      onClick={() => openReport(report)}
                      data-testid={`button-open-report-${report.id}`}
                    >
                      <span className="scan-report-date">{new Date(report.approvedAt).toLocaleDateString("ar", { day: "numeric", month: "short", year: "numeric" })}</span>
                      <span className="scan-report-title">{report.approvedFields.location?.value || "إعلان عقاري"}</span>
                      <span className="scan-report-arrow" aria-hidden="true">←</span>
                    </button>
                    {deleteConfirmId === report.id ? (
                      <div className="scan-report-confirm" role="group" aria-label={`تأكيد حذف تقرير ${report.id}`}>
                        <span>حذف هذا التقرير؟</span>
                        <button type="button" onClick={() => deleteReport(report.id)} data-testid={`button-confirm-delete-report-${report.id}`}>نعم، احذف</button>
                        <button type="button" onClick={() => setDeleteConfirmId(null)} data-testid={`button-cancel-delete-report-${report.id}`}>إلغاء</button>
                      </div>
                    ) : (
                      <button
                        className="scan-delete-report"
                        type="button"
                        onClick={() => deleteReport(report.id)}
                        aria-label={`حذف التقرير ${report.approvedFields.location?.value || ""}`}
                        data-testid={`button-delete-report-${report.id}`}
                      >حذف</button>
                    )}
                  </li>
                ))}
              </ul>
            ) : !storageError ? (
              <div className="scan-empty-saved" data-testid="empty-saved-reports">
                <span className="scan-empty-mark" aria-hidden="true">—</span>
                <p>لا توجد تقارير بعد</p>
                <small>ستظهر هنا بعد اعتماد أول مراجعة.</small>
              </div>
            ) : null}
            <p className="scan-capacity-note">عند بلوغ ٣٠ تقريراً، احذف تقريرًا من القائمة لإتاحة حفظ تقرير جديد.</p>
          </aside>
        </section>

        {busy && (
          <section className="scan-loading" aria-live="polite" aria-label="جارٍ تحليل الإعلان">
            <div className="scan-loading-heading"><span className="scan-loading-bar" /><span>نقرأ النص بحثاً عن تفاصيل قابلة للتحقق</span></div>
            <div className="scan-skeleton-grid">
              {FIELD_DEFS.slice(0, 4).map(([key]) => <div className="scan-skeleton" key={key}><span /><i /><i /></div>)}
            </div>
          </section>
        )}

        {analysis && !busy && currentFields && (
          <section className="scan-results" aria-labelledby="results-title" data-testid="section-analysis-results">
            <div className="scan-results-heading">
              <div>
                <span className="scan-step">02</span>
                <h2 id="results-title">قراءة الإعلان</h2>
                <p>كل خانة تعكس ما يقوله النص، لا ما نفترضه عن العقار.</p>
              </div>
              <span className={`scan-mode-pill mode-${analysis.mode}`} data-testid="status-analysis-mode">
                <span />{analysis.mode === "ai" ? "تحليل ذكي" : "وضع تجريبي"}
              </span>
            </div>

            <div className={`scan-mode-notice mode-${analysis.mode}`} role="status" data-testid="text-mode-notice">
              <span className="scan-notice-icon" aria-hidden="true">i</span>
              <p>{analysis.notice || (analysis.mode === "demo" ? "هذه نتيجة تجريبية. راجع كل اقتباس قبل الاعتماد." : "راجع التفاصيل والاقتباسات قبل اعتمادها.")}</p>
            </div>

            {activeSaved && (
              <div className="scan-saved-context" data-testid="text-saved-context">
                <strong>تقرير محفوظ — البيانات المعتمدة سابقاً</strong>
                <span>النتيجة الأصلية أدناه لم تتغير. التعديلات الحالية غير معتمدة حتى تؤكدها.</span>
              </div>
            )}

            <div className="scan-field-grid">
              {FIELD_DEFS.map(([key, label]) => {
                const field = currentFields[key];
                return (
                  <article className={`scan-field-card status-${field.status}`} key={key} data-testid={`card-field-${key}`}>
                    <div className="scan-field-top">
                      <label htmlFor={`field-value-${key}`}>{label}</label>
                      <span className={`scan-status status-${field.status}`}>
                        <i aria-hidden="true" />{statusLabel(field.status)}
                      </span>
                    </div>
                    <input
                      id={`field-value-${key}`}
                      type="text"
                      dir="auto"
                      value={field.status === "found" ? field.value ?? "" : ""}
                      placeholder={field.status === "missing" ? "لم يرد في النص" : field.status === "unclear" ? "يحتاج إلى توضيح" : "أدخل القيمة"}
                      disabled={busy || field.status !== "found"}
                      onChange={(event) => editField(key, { value: event.target.value })}
                      data-testid={`input-field-${key}`}
                    />
                    <label className="scan-status-select-label" htmlFor={`field-status-${key}`}>حالة المعلومة</label>
                    <select
                      id={`field-status-${key}`}
                      value={field.status}
                      onChange={(event) => editField(key, { status: event.target.value })}
                      disabled={busy}
                      data-testid={`select-status-${key}`}
                    >
                      <option value="found">مذكور في الإعلان</option>
                      <option value="missing">غير مذكور</option>
                      <option value="unclear">غير واضح</option>
                    </select>
                    <div className="scan-evidence">
                      <span className="scan-evidence-label">الدليل من النص الأصلي</span>
                      {originalFields[key].evidence.length ? (
                        <ul>
                          {originalFields[key].evidence.map((quote, index) => (
                            <li key={`${key}-${index}`} dir="auto" data-testid={`text-evidence-${key}-${index}`}>“{quote}”</li>
                          ))}
                        </ul>
                      ) : <p className="scan-no-evidence">لا يوجد اقتباس لهذا الحقل.</p>}
                    </div>
                  </article>
                );
              })}
            </div>

            {analysis.contradictions.length > 0 && (
              <section className="scan-subsection scan-contradictions" aria-labelledby="contradictions-title">
                <div className="scan-subsection-heading"><span className="scan-section-mark">!</span><div><h3 id="contradictions-title">تعارضات تحتاج مراجعة</h3><p>اختلافات داخل نص الإعلان نفسه، وليست حكماً على صحة العقار.</p></div></div>
                <ul className="scan-contradiction-list">
                  {analysis.contradictions.map((item, index) => (
                    <li key={`${item.field}-${index}`} data-testid={`item-contradiction-${index}`}>
                      <strong>{item.field}</strong><span>{item.message}</span>
                      {item.evidence.map((quote, quoteIndex) => <blockquote key={quoteIndex} dir="auto">“{quote}”</blockquote>)}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {analysis.questions.length > 0 && (
              <section className="scan-subsection scan-questions" aria-labelledby="questions-title">
                <div className="scan-subsection-heading"><span className="scan-section-mark">؟</span><div><h3 id="questions-title">أسئلة للبائع</h3><p>نقاط محددة تساعدك على طلب معلومات أوضح.</p></div></div>
                <ol>{analysis.questions.map((question, index) => <li key={index} data-testid={`item-question-${index}`}>{question}</li>)}</ol>
              </section>
            )}

            <section className="scan-limitations" aria-labelledby="limitations-title" data-testid="section-limitations">
              <div className="scan-limit-icon" aria-hidden="true">i</div>
              <div><h3 id="limitations-title">حدود هذه المراجعة</h3>
                {analysis.limitations.length ? <ul>{analysis.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul> : <p>هذه قراءة لنص الإعلان فقط. لا تتحقق من صحة البيانات أو حالة العقار أو الملكية القانونية.</p>}
              </div>
            </section>

            <div className="scan-approval-panel">
              <label className="scan-approval-check">
                <input
                  type="checkbox"
                  checked={approval}
                  onChange={(event) => setApproval(event.target.checked)}
                  disabled={busy}
                  data-testid="checkbox-approve-report"
                />
                <span className="scan-check-visual" aria-hidden="true" />
                <span><strong>راجعت البيانات وأوافق على حفظ هذه النسخة</strong><small>اعتمادك يخص القيم والحالات المعدّلة فقط، ولا يغيّر نتيجة التحليل الأصلية.</small></span>
              </label>
              <button
                type="button"
                className="scan-save-button"
                onClick={saveReport}
                disabled={!approval || busy || savedReports.length >= MAX_SAVED_REPORTS}
                data-testid="button-save-report"
              >احفظ التقرير <span aria-hidden="true">←</span></button>
            </div>
            {approvalError && <p className="scan-error" role="alert" data-testid="status-approval-error">{approvalError}</p>}
            {savedReports.length >= MAX_SAVED_REPORTS && (
              <p className="scan-error scan-storage-error" role="status" data-testid="status-report-limit">
                اكتملت سعة ٣٠ تقريراً على هذا الجهاز. لن يُستبدل أي تقرير؛ احذف تقريرًا من القائمة قبل الحفظ.
              </p>
            )}
            {notice && <p className="scan-inline-notice" role="status" data-testid="status-action-notice">{notice}</p>}

            <details className="scan-original-details">
              <summary>عرض نتيجة التحليل الأصلية كما وصلت</summary>
              <div className="scan-original-summary">
                <span>غير معدّلة · {analysis.mode === "ai" ? "تحليل ذكي" : "وضع تجريبي"}</span>
                <p>{analysis.notice || "لا توجد ملاحظة إضافية."}</p>
                <div className="scan-original-grid">
                  {FIELD_DEFS.map(([key, label]) => <div key={key}><strong>{label}</strong><span>{statusLabel(originalFields[key].status)}</span><p>{originalFields[key].status === "found" ? originalFields[key].value : "—"}</p></div>)}
                </div>
              </div>
            </details>
          </section>
        )}

        <footer className="scan-footer">
          <span>باجِر <i>·</i> أداة قراءة للإعلان، لا بديلاً عن التحقق المستقل.</span>
          <span>نتائج مدعومة بالنص فقط</span>
        </footer>
      </div>
    </main>
  );
}

export default Scan;
