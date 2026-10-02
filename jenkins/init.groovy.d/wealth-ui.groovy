import jenkins.model.Jenkins

def html = '''
<div class="wealth-ci-banner">
  <span>Wealth CI：按分支构建、按完整 Commit 回放、最近 10 个版本一键启动。</span>
  <a href="/userContent/wealth/">打开新控制台</a>
</div>
'''

def j = Jenkins.instance
try {
  j.setMarkupFormatter(new hudson.markup.RawHTMLMarkupFormatter(false))
} catch (Throwable ignored) {
}
j.setSystemMessage(html.trim())

try {
  def clazz = Class.forName('org.codefirst.SimpleThemeDecorator')
  def decorator = j.getExtensionList(clazz).find { true }
  if (decorator != null) {
    def cssClazz = Class.forName('org.jenkinsci.plugins.simpletheme.CssUrlThemeElement')
    def css = cssClazz.getConstructor(String.class).newInstance('/userContent/wealth/jenkins-theme.css')
    decorator.elements = [css]
    println 'Wealth UI: simple-theme CSS 已挂载'
  }
} catch (ClassNotFoundException ignored) {
  println 'Wealth UI: 未安装 simple-theme-plugin，仅设置系统横幅'
} catch (Throwable t) {
  println "Wealth UI: 主题设置跳过 ${t.message}"
}

println 'Wealth UI: 系统横幅已更新 → /userContent/wealth/'
