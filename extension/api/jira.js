export class JiraAPI {
  constructor({ baseUrl, email, apiToken }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.auth = btoa(`${email}:${apiToken}`);
  }

  async fetchAgile(path, options = {}) {
    const url = `${this.baseUrl}/rest/agile/1.0${path}`;
    let res;
    try {
      res = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Basic ${this.auth}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      });
    } catch (e) {
      throw new Error(`Jira network error: ${e.message}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jira Agile API ${res.status}: ${text}`);
    }
    return res.json();
  }

  async fetch(path, options = {}) {
    const url = `${this.baseUrl}/rest/api/3${path}`;
    let res;
    try {
      res = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Basic ${this.auth}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      });
    } catch (e) {
      throw new Error(`Jira network error — check your Base URL (${this.baseUrl}) and internet connection. Detail: ${e.message}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jira API ${res.status}: ${text}`);
    }
    if (res.status === 204 || res.headers.get('content-length') === '0') return null;
    return res.json();
  }

  async getCurrentUser() {
    return this.fetch('/myself');
  }

  /**
   * Fetch all option-type custom fields that have values on issues in a given project.
   * Returns [{ id, name }] sorted by name.
   */
  async getProjectCustomFields(projectKey) {
    // Build a map of all custom field definitions
    const allFields = await this.fetch('/field');
    const fieldMap = new Map();
    for (const f of allFields) {
      if (!f.custom) continue;
      const type = f.schema?.type;
      const items = f.schema?.items;
      // Only option-type fields (single or multi select)
      if (type === 'option' || (type === 'array' && items === 'option')) {
        fieldMap.set(f.id, f.name);
      }
    }

    // Sample recent issues from the project to find which option fields are populated
    const jql = encodeURIComponent(`project = "${projectKey}" ORDER BY updated DESC`);
    const fieldIds = [...fieldMap.keys()].join(',');
    const data = await this.fetch(
      `/search/jql?jql=${jql}&fields=${fieldIds}&maxResults=30`
    );

    const seen = new Map();
    for (const issue of data.issues || []) {
      for (const [key, val] of Object.entries(issue.fields || {})) {
        if (!fieldMap.has(key) || seen.has(key)) continue;
        const hasValue = Array.isArray(val) ? val.some(v => v?.value) : val?.value;
        if (hasValue) seen.set(key, fieldMap.get(key));
      }
    }
    // Prepend built-in Status field
    const result = [{ id: 'status', name: 'Status' }, ...[...seen.entries()].map(([id, name]) => ({ id, name }))];
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Fetch all distinct values in use for a given custom field ID within a project.
   */
  async getFieldValues(fieldId, projectKey) {
    const jql = encodeURIComponent(`project = "${projectKey}" ORDER BY updated DESC`);
    const data = await this.fetch(`/search/jql?jql=${jql}&fields=${fieldId}&maxResults=200`);
    const seen = new Set();
    for (const issue of data.issues || []) {
      const val = issue.fields?.[fieldId];
      if (val?.value) seen.add(val.value);
      else if (val?.name) seen.add(val.name);
      if (Array.isArray(val)) val.forEach(v => { if (v?.value) seen.add(v.value); else if (v?.name) seen.add(v.name); });
    }
    return [...seen].sort();
  }

  /**
   * Return the user's favourite/saved filters — these back Jira "views".
   */
  async getMyFilters() {
    const data = await this.fetch('/filter/my?expand=jql&maxResults=100');
    return (Array.isArray(data) ? data : (data.values || [])).map(f => ({
      id: f.id,
      name: f.name,
      jql: f.jql,
      owner: f.owner?.displayName,
    }));
  }

  /**
   * Fetch issues using an arbitrary JQL string (e.g. from a saved filter).
   */
  async getIssuesByJql(jql, maxResults = 100) {
    const fields = 'summary,status,priority,assignee,reporter,updated,created,project,issuetype';
    const data = await this.fetch(
      `/search/jql?jql=${encodeURIComponent(jql)}&fields=${fields}&maxResults=${maxResults}`
    );
    return (data.issues || []).map(issue => ({
      id: issue.id,
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name,
      priority: issue.fields.priority?.name || 'Medium',
      assignee: issue.fields.assignee?.displayName || 'Unassigned',
      reporter: issue.fields.reporter?.displayName,
      updated: issue.fields.updated,
      created: issue.fields.created,
      project: issue.fields.project?.name,
      projectKey: issue.fields.project?.key,
      issueType: issue.fields.issuetype?.name,
      url: `${this.baseUrl}/browse/${issue.key}`,
    }));
  }

  /**
   * List all Jira projects (Spaces) the user has access to.
   */
  async getProjects() {
    const data = await this.fetch('/project/search?maxResults=100&orderBy=name&expand=projectKeys');
    return (data.values || []).map(p => ({
      id: p.id,
      key: p.key,
      name: p.name,
      type: p.projectTypeKey, // 'software', 'business', 'service_desk'
      style: p.style,         // 'next-gen' | 'classic'
      avatarUrl: p.avatarUrls?.['24x24'],
    }));
  }

  /**
   * Get the column configuration for a board.
   * Returns columns with their mapped statuses.
   */
  async getBoardColumns(boardId) {
    const data = await this.fetchAgile(`/board/${boardId}/configuration`);
    return (data.columnConfig?.columns || []).map(col => ({
      name: col.name,
      statuses: (col.statuses || []).map(s => ({ id: s.id, name: s.name || s.id })),
    }));
  }

  /**
   * List boards accessible to the user, optionally scoped to a specific project/space.
   */
  async getBoards({ maxResults = 50, projectKey = null } = {}) {
    const filter = projectKey ? `&projectKeyOrId=${encodeURIComponent(projectKey)}` : '';
    const data = await this.fetchAgile(`/board?maxResults=${maxResults}&orderBy=name${filter}`);
    return (data.values || []).map(b => ({
      id: b.id,
      name: b.name,
      type: b.type, // 'scrum' | 'kanban'
      projectKey: b.location?.projectKey,
      projectName: b.location?.projectName,
    }));
  }

  /**
   * Fetch all issues on a specific board (active sprint for scrum, backlog for kanban).
   * Applies optional JQL filter on top.
   */
  async getBoardIssues(boardId, { jqlFilter = '', statusName = '', statusNames = [] } = {}) {
    const fields = 'summary,status,priority,assignee,reporter,updated,created,project,issuetype';

    // Build status filter — prefer statusNames array, fall back to single statusName
    const allStatuses = statusNames.length ? statusNames : (statusName ? [statusName] : []);
    const statusJql = allStatuses.length
      ? `status in (${allStatuses.map(s => `"${s}"`).join(',')})`
      : '';

    // Try active sprint first (scrum boards)
    let issues = [];
    try {
      const sprintData = await this.fetchAgile(`/board/${boardId}/sprint?state=active&maxResults=1`);
      const activeSprint = sprintData.values?.[0];
      if (activeSprint) {
        let jql = `sprint = ${activeSprint.id}`;
        if (statusJql) jql += ` AND ${statusJql}`;
        if (jqlFilter) jql += ` AND (${jqlFilter})`;
        jql += ' ORDER BY priority ASC, updated DESC';
        const data = await this.fetchAgile(`/board/${boardId}/issue?jql=${encodeURIComponent(jql)}&fields=${fields}&maxResults=100`);
        issues = data.issues || [];
      }
    } catch (_) {
      // Not a scrum board or no active sprint — fall back to board issues
    }

    if (!issues.length) {
      let jql = statusJql;
      if (jqlFilter) jql += jql ? ` AND (${jqlFilter})` : jqlFilter;
      if (jql) jql += ' ORDER BY priority ASC, updated DESC';
      const path = `/board/${boardId}/issue?fields=${fields}&maxResults=100${jql ? `&jql=${encodeURIComponent(jql)}` : ''}`;
      const data = await this.fetchAgile(path);
      issues = data.issues || [];
    }

    return issues.map(issue => ({
      id: issue.id,
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name,
      priority: issue.fields.priority?.name || 'Medium',
      assignee: issue.fields.assignee?.displayName || 'Unassigned',
      reporter: issue.fields.reporter?.displayName,
      updated: issue.fields.updated,
      created: issue.fields.created,
      project: issue.fields.project?.name,
      projectKey: issue.fields.project?.key,
      issueType: issue.fields.issuetype?.name,
      url: `${this.baseUrl}/browse/${issue.key}`,
    }));
  }

  /**
   * Fetch all issues where custom field "Design Status" matches one or more values.
   * reviewValues can be a string (legacy) or array of strings.
   */
  async getReviewIssues(reviewValues = 'Need Your Review', projectKey = null, fieldName = 'Design Status', sortFieldId = null, excludeFieldIds = [], filterFieldId = null) {
    const vals = Array.isArray(reviewValues) ? reviewValues.filter(Boolean) : [reviewValues].filter(Boolean);
    if (!vals.length) return []; // nothing to filter by — return empty list
    const projectClause = projectKey ? `project = "${projectKey}" AND ` : '';
    const valueClause = vals.length === 1
      ? `"${fieldName}" = "${vals[0]}"`
      : `"${fieldName}" in (${vals.map(v => `"${v}"`).join(', ')})`;
    const jql = encodeURIComponent(
      `${projectClause}${valueClause} ORDER BY updated DESC`
    );
    const baseFields = 'summary,status,priority,assignee,reporter,updated,created,project,issuetype,description';
    const extraFields = new Set(excludeFieldIds);
    if (sortFieldId) extraFields.add(sortFieldId);
    if (filterFieldId) extraFields.add(filterFieldId);
    // 'status' is already in baseFields
    extraFields.delete('status');
    const fields = extraFields.size ? `${baseFields},${[...extraFields].join(',')}` : baseFields;
    const data = await this.fetch(`/search/jql?jql=${jql}&fields=${fields}&maxResults=50`);
    return (data.issues || []).map(issue => {
      const excludeFieldValues = {};
      for (const fid of excludeFieldIds) {
        const val = issue.fields?.[fid];
        // Handle: object with .value (select), object with .name (status/priority),
        // plain string, array (multi-select → join), or null/missing
        if (val === null || val === undefined) {
          excludeFieldValues[fid] = null;
        } else if (typeof val === 'string') {
          excludeFieldValues[fid] = val;
        } else if (Array.isArray(val)) {
          excludeFieldValues[fid] = val.map(v => v?.value ?? v?.name ?? String(v)).join(', ');
        } else {
          excludeFieldValues[fid] = val.value ?? val.name ?? String(val);
        }
      }
      const filterVal = filterFieldId ? issue.fields?.[filterFieldId] : null;
      return {
        id: issue.id,
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status?.name,
        priority: issue.fields.priority?.name || null,
        priorityIconUrl: issue.fields.priority?.iconUrl,
        assignee: issue.fields.assignee?.displayName || 'Unassigned',
        reporter: issue.fields.reporter?.displayName,
        updated: issue.fields.updated,
        created: issue.fields.created,
        project: issue.fields.project?.name,
        projectKey: issue.fields.project?.key,
        issueType: issue.fields.issuetype?.name,
        url: `${this.baseUrl}/browse/${issue.key}`,
        sortFieldValue: sortFieldId ? (issue.fields[sortFieldId]?.value ?? null) : null,
        excludeFieldValues,
        filterFieldValue: filterFieldId ? (filterVal?.value ?? filterVal?.name ?? null) : null,
      };
    });
  }

  async updateIssueField(issueKey, fieldId, value) {
    if (fieldId === 'status') {
      const data = await this.fetch(`/issue/${issueKey}/transitions`);
      const t = (data.transitions || []).find(t => t.name === value || t.to?.name === value);
      if (!t) throw new Error(`No transition to "${value}" available on ${issueKey}`);
      await this.fetch(`/issue/${issueKey}/transitions`, {
        method: 'POST',
        body: JSON.stringify({ transition: { id: t.id } }),
      });
    } else {
      await this.fetch(`/issue/${issueKey}`, {
        method: 'PUT',
        body: JSON.stringify({ fields: { [fieldId]: { value } } }),
      });
    }
  }

  /**
   * Fetch issues assigned to current user that need review
   */
  async getMyReviewIssues(statusName = 'Need Your Review') {
    const jql = encodeURIComponent(
      `status = "${statusName}" AND assignee = currentUser() ORDER BY priority ASC, updated DESC`
    );
    const fields = 'summary,status,priority,assignee,reporter,updated,project,issuetype';
    const data = await this.fetch(`/search/jql?jql=${jql}&fields=${fields}&maxResults=50`);
    return (data.issues || []).map(issue => ({
      id: issue.id,
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name,
      priority: issue.fields.priority?.name || 'Medium',
      assignee: issue.fields.assignee?.displayName || 'Unassigned',
      reporter: issue.fields.reporter?.displayName,
      updated: issue.fields.updated,
      project: issue.fields.project?.name,
      projectKey: issue.fields.project?.key,
      issueType: issue.fields.issuetype?.name,
      url: `${this.baseUrl}/browse/${issue.key}`,
    }));
  }
}
