'use client';

import { JobsTable } from '@/components/jobs-table';
import { SettingsLine } from '@/components/summary';
import { Panel } from '@/components/ui';

export default function JobsPage() {
  return (
    <Panel title="Jobs">
      <div className="space-y-3">
        <SettingsLine />
        <JobsTable />
      </div>
    </Panel>
  );
}
