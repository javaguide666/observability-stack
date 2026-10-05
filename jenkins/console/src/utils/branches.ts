import { BRANCH_PRIORITY } from '@/api/constants'

/** 候选分支排序：main、dev 等优先，其余字母序；返回时第一个即推荐 */
export function sortCandidates(list: string[]): string[] {
  const rank = (b: string) => {
    const i = BRANCH_PRIORITY.indexOf(b)
    return i === -1 ? BRANCH_PRIORITY.length : i
  }
  return [...new Set(list)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** 把分支名转成 IMAGE_TAG 前缀（feature/x -> feature-x） */
export function branchToTagPrefix(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-')
}
