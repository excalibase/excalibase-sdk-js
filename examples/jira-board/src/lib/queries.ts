import { gql } from "graphql-request";

export const PROJECTS = gql`
  query Projects {
    kanbanProjects(orderBy: { id: ASC }) {
      id
      name
      key
      description
      is_public
      org_id
      archived
    }
  }
`;

export const ISSUES_FOR_PROJECT = gql`
  query IssuesForProject($projectId: Int!) {
    kanbanIssues(where: { project_id: { eq: $projectId } }, orderBy: { id: ASC }) {
      id
      project_id
      sprint_id
      title
      description
      priority
      status
      story_points
      reporter_id
      assignee_id
      created_at
      updated_at
      kanbanComments(orderBy: { created_at: ASC }) {
        id
        body
        author_id
        created_at
      }
      kanbanIssueLabels {
        kanbanLabels {
          id
          name
          color
        }
      }
    }
  }
`;

export const USERS = gql`
  query Users {
    kanbanUsers(orderBy: { id: ASC }) {
      id
      name
      email
      role
      avatar_url
    }
  }
`;

export const WHOAMI = gql`
  query Whoami {
    kanbanWhoamiView {
      role
    }
  }
`;
