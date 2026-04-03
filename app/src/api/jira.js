// Encode credentials to Base64 for Basic Auth (React Native compatible)
function toBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

export class JiraAPI {
  constructor({ baseUrl, email, apiToken }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.auth = toBase64(`${email}:${apiToken}`);
  }

  async fetchAgile(path, options = {}) {
    const url = `${this.baseUrl}/rest/agile/1.0${path}`;
    let res;
    try {
      res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: 'application/json',
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
          Authorization: `Basic ${this.auth}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      });
    } catch (e) {
      throw new Error(
        `Jira network error — check your Base URL (${this.baseUrl}) and internet connection. Detail: ${e.message}`
      );
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

  async getProjectCustomFields(projectKey) {
    const allFields = await this.fetch('/field');
    const fieldMap = new Map();
    for (const f of allFields) {
      if (!f.custom) continue;
      const type = f.schema?.type;
      const items = f.schema?.items;
      if (type === 'option' || (type === 'array' && items === 'option')) {
        fieldMap.set(f.id, f.name);
      }
    }
    const jql = encodeURIComponent(`project = "${projectKey}" ORDER BY updated DESC`);
    const fieldIds = [...fieldMap.keys()].join(',');
    const data = await this.fetch(`/search/jql?jql=${jql}&fields=${fieldIds}&maxResults=30`);
    const seen = new Map();
    for (const issue of data.issues || []) {
      for (const [key, val] of Object.entries(issue.fields || {})) {
        if (!fieldMap.has(key) || seen.has(key)) continue;
        const hasValue = Array.isArray(val) ? val.some(v => v?.value) : val?.value;
        if (hasValue) seen.set(key, fieldMap.get(key));
      }
    }
    const result = [
      { id: 'status', name: 'Status' },
      ...[...seen.entries()].map(([id, name]) => ({ id, name })),
    ];
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getFieldValues(fieldId, projectKey) {
    const jql = encodeURIComponent(`project = "${projectKey}" ORDER BY updated DESC`);
    const data = await this.fetch(`/search/jql?jql=${jql}&fields=${fieldId}&maxResults=200`);
    const seen = new Set();
    for (const issue of data.issues || []) {
      const val = issue.fields?.[fieldId];
      if (val?.value) seen.add(val.value);
      else if (val?.name) seen.add(val.name);
      if (Array.isArray(val))
        val.forEach(v => {
          if (v?.value) seen.add(v.value);
          else if (v?.name) seen.add(v.name);
        });
    }
    return [...seen].sort();
  }

  async getProjects() {
    const data = await this.fetch('/project/search?maxResults=100&orderBy=name&expand=projectKeys');
    return (data.values || []).map(p => ({
      id: p.id,
      key: p.key,
      name: p.name,
      type: p.projectTypeKey,
      style: p.style,
    }));
  }

  async getBoards({ maxResults = 50, projectKey = null } = {}) {
    const filter = projectKey ? `&projectKeyOrId=${encodeURIComponent(projectKey)}` : '';
    const data = await this.fetchAgile(`/board?maxResults=${maxResults}&orderBy=name${filter}`);
    return (data.values || []).map(b => ({
      id: b.id,
      name: b.name,
      type: b.type,
      projectKey: b.location?.projectKey,
      projectName: b.location?.projectName,
    }));
  }

  async getReviewIssues(
    reviewValues = 'Need Your Review',
    projectKey = null,
    fieldName = 'Design Status',
    sortFieldId = null,
    excludeFieldIds = [],
    filterFieldId = null
  ) {
    const vals = Array.isArray(reviewValues) ? reviewValues.filter(Boolean) : [reviewValues].filter(Boolean);
    if (!vals.length) return [];
    const projectClause = projectKey ? `project = "${projectKey}" AND ` : '';
    const valueClause =
      vals.length === 1
        ? `"${fieldName}" = "${vals[0]}"`
        : `"${fieldName}" in (${vals.map(v => `"${v}"`).join(', ')})`;
    const jql = encodeURIComponent(`${projectClause}${valueClause} ORDER BY updated DESC`);
    const baseFields =
      'summary,status,priority,assignee,reporter,updated,created,project,issuetype,description';
    const extraFields = new Set(excludeFieldIds);
    if (sortFieldId) extraFields.add(sortFieldId);
    if (filterFieldId) extraFields.add(filterFieldId);
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
        filterFieldValue: filterFieldId
          ? (filterVal?.value ?? filterVal?.name ?? null)
          : null,
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
}
