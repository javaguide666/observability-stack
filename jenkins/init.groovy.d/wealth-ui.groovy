import jenkins.model.Jenkins

// 横幅只在 Raw HTML 格式化器可用时写入。类名必须是 RawHtmlMarkupFormatter
// （antisamy-markup-formatter）。写错时 Jenkins 会把标签转义成纯文本，首页就会出现 HTML 源码。
def html = '''
<div class="wealth-ci-banner">
  <a href="http://localhost:18080/userContent/wealth/index.html#/">打开自定义控制台</a>
</div>
'''.trim()

def plain = '打开自定义控制台：http://localhost:18080/userContent/wealth/index.html#/'

def j = Jenkins.instance
def rendered = false
try {
  def formatter = new hudson.markup.RawHtmlMarkupFormatter(false)
  def out = formatter.translate(html)
  if (out != null && out.contains('<a ') && !out.contains('&lt;')) {
    j.setMarkupFormatter(formatter)
    j.setSystemMessage(html)
    rendered = true
  }
} catch (Throwable t) {
  println "Wealth UI: RawHtmlMarkupFormatter 不可用 ${t.message}"
}
if (!rendered) {
  j.setSystemMessage(plain)
  println 'Wealth UI: 系统消息改为纯文本，避免首页显示 HTML 源码'
}
j.save()

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

println 'Wealth UI: 首页只保留「打开自定义控制台」'
