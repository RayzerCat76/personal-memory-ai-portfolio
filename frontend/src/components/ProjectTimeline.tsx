"use client";

import styles from "./Study.module.css";
import type { StudyRecord } from "@/lib/study-store";
import { projectTimeline, ProjectTimelineItem } from "@/lib/project-timeline";
import { useUiLocale } from "@/lib/ui-locale";

function TimelineItem({ item, last }: { item: ProjectTimelineItem; last: boolean }) {
  return <div className={styles.timelineRow} data-timeline-key={item.key}>
    <div className={styles.timelineRail} aria-hidden="true">
      <span className={styles.timelineDot} />
      {!last && <span className={styles.timelineLine} />}
    </div>
    <div className={styles.timelineContent}>
      <div className={styles.timelineHeading}>
        <strong>{item.title}</strong>
        {item.dateLabel && <time>{item.dateLabel}</time>}
      </div>
      <div className={styles.timelineMeta}>
        <span>{item.kind}</span>
        {item.parent && <span>· {item.parent}</span>}
        <span>· {item.status}</span>
        {item.temporal && <span>· {item.temporal}</span>}
      </div>
    </div>
  </div>;
}

export default function ProjectTimeline({ project }: { project: StudyRecord }) {
  const { t } = useUiLocale();
  const { dated, unscheduled } = projectTimeline(project);
  const all = [...dated, ...unscheduled];  return <section className={styles.projectTimeline} aria-label="Project timeline">
    <div className={styles.timelineTitleRow}>
      <h3>{t("Timeline", "时间线")}</h3>
      <small>{t("Only explicit dates are used.", "仅使用明确填写的日期。")}</small>
    </div>
    {!all.length && <p>{t("No dated or unscheduled project items yet.", "还没有带日期或未安排日期的项目事项。")}</p>}
    {dated.length > 0 && <div className={styles.timelineGroup} aria-label="Dated timeline items">
      <div className={styles.previewLabel}>{t("Chronological", "按时间顺序")}</div>
      {dated.map((item, index) => <TimelineItem key={item.key} item={item} last={index === dated.length - 1} />)}
    </div>}
    {unscheduled.length > 0 && <div className={styles.timelineGroup} aria-label="Unscheduled timeline items">
      <div className={styles.previewLabel}>{t("Unscheduled", "未安排日期")}</div>
      <small className={styles.timelineExplanation}>{t("These items have no explicit date, so they are not placed on the chronology.", "这些事项没有明确日期，因此不会放入时间顺序中。")}</small>
      {unscheduled.map((item, index) => <TimelineItem key={item.key} item={item} last={index === unscheduled.length - 1} />)}
    </div>}
  </section>;
}